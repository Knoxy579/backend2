const db = require('../config/db');
const { generatePaytrToken, verifyPaytrHash } = require('../services/paytrService');
const axios = require('axios');

// ── Self-Healing Migration: payment_logs tablosuna wifi kolonlarını ekle ──
(async () => {
    try {
        await db.promise().execute("ALTER TABLE payment_logs ADD COLUMN wifi_ssid VARCHAR(255) NULL");
        console.log("✅ [MIGRATION] payment_logs tablosuna wifi_ssid kolonu eklendi.");
    } catch (e) { /* Zaten var, yoksay */ }
    try {
        await db.promise().execute("ALTER TABLE payment_logs ADD COLUMN wifi_password VARCHAR(255) NULL");
        console.log("✅ [MIGRATION] payment_logs tablosuna wifi_password kolonu eklendi.");
    } catch (e) { /* Zaten var, yoksay */ }
    try {
        await db.promise().execute("ALTER TABLE payment_logs ADD COLUMN whatsapp_selected TINYINT(1) DEFAULT 0");
        console.log("✅ [MIGRATION] payment_logs tablosuna whatsapp_selected kolonu eklendi.");
    } catch (e) { /* Zaten var, yoksay */ }
    // WhatsApp sipariş bildirimi kolonu
    try {
        await db.promise().execute("ALTER TABLE restaurant_settings ADD COLUMN whatsapp_order_notify TINYINT(1) DEFAULT 1");
        console.log("✅ [MIGRATION] restaurant_settings tablosuna whatsapp_order_notify kolonu eklendi.");
    } catch (e) { /* Zaten var, yoksay */ }
})();

/**
 * 1. Adım: PayTR'den Ödeme Sayfası Tokenı Alır.
 */
exports.getPaymentToken = async (req, res) => {
    try {
        const restaurant_id = req.restaurant_id;
        const { user_name, user_address, user_phone, couponCode, plan_id = 1, wifi_ssid, wifi_password, whatsapp_selected = 0, whatsapp_phone = null } = req.body;

        // IP Adresi Tespiti (Çoklu IP varsa sadece ilkini al - PayTR kuralı)
        let user_ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || "1.1.1.1";
        if (user_ip.includes(',')) {
            user_ip = user_ip.split(',')[0].trim();
        }

        // Email bilgisini body'den veya auth'dan al, yoksa yedek kullan
        const email = req.body.email || req.user?.email || "destek@kutyemek.com";

        if (!restaurant_id) {
            return res.status(400).json({ error: 'Restaurant ID bulunamadı. Lütfen tekrar giriş yapın.' });
        }

        // 1. Planı Databaseden çek
        const [plans] = await db.promise().execute('SELECT * FROM subscription_plans WHERE id = ? AND active = 1', [plan_id]);
        if (plans.length === 0) {
            return res.status(400).json({ error: 'Geçerli bir abonelik planı bulunamadı.' });
        }
        const plan = plans[0];
        let finalPrice = parseFloat(plan.price);

        let validCouponCode = null;

        // --- DENE10 TRIAL KUPONU TEKRAR KULLANIM ENGELİ ---
        if (couponCode === 'DENE10') {
            const [existingTrial] = await db.promise().execute(
                'SELECT trial_coupon_code FROM subscriptions WHERE restaurant_id = ? AND trial_coupon_code IS NOT NULL LIMIT 1',
                [restaurant_id]
            );
            if (existingTrial.length > 0) {
                return res.status(400).json({
                    error: 'Bu işletme daha önce deneme kuponu kullanmıştır. Her işletme yalnızca 1 kez deneme hakkına sahiptir.'
                });
            }
        }

        // 2. Kupon kontrolü ve indirim hesaplama
        if (couponCode) {
            // A. Önce Bayi Kuponu (CEMIL-4 vs) mu diye kontrol et
            if (couponCode.includes('-') && ['1', '2', '3', '4'].includes(couponCode.split('-')[1])) {
                const parts = couponCode.split('-');
                const baseCode = parts[0];
                const tier = parseInt(parts[1]);

                const [partners] = await db.promise().execute('SELECT full_name, status FROM partners WHERE base_code = ?', [baseCode]);

                if (partners.length > 0 && partners[0].status === 'active') {
                    const maxDiscount = process.env.MAX_PARTNER_DISCOUNT ? parseInt(process.env.MAX_PARTNER_DISCOUNT) : 40;
                    const tierStep = maxDiscount / 4;
                    const calculatedDiscount = Math.round((tier * tierStep) / 5) * 5 || (tier * 5);

                    validCouponCode = couponCode;
                    finalPrice = finalPrice - (finalPrice * (calculatedDiscount / 100));
                }
            }

            // B. Eğer Bayi Kuponu değilse eski sabit kuponlara bak
            if (!validCouponCode) {
                const [coupons] = await db.promise().execute(
                    'SELECT * FROM subscription_coupons WHERE code = ? AND active = 1 AND (expires_at IS NULL OR expires_at > NOW()) AND (usage_limit IS NULL OR used_count < usage_limit)',
                    [couponCode]
                );
                if (coupons.length > 0) {
                    const coupon = coupons[0];
                    validCouponCode = coupon.code;
                    if (coupon.discount_type === 'percentage') {
                        finalPrice = finalPrice - (finalPrice * (parseFloat(coupon.discount_amount) / 100));
                    } else if (coupon.discount_type === 'fixed') {
                        finalPrice = finalPrice - parseFloat(coupon.discount_amount);
                    }
                }
            }
            if (finalPrice < 0) finalPrice = 0;
        }

        // PayTR 0 TL lik işlem kabul etmez. (%100 İndirim verilmişse)
        if (finalPrice <= 0) {
            return res.status(400).json({ error: '%100 İndirim kodları PayTR kullanılarak tahsil edilemez. Lütfen yönetici ile direkt iletişime geçin.' });
        }

        // 3. Sipariş Detayları
        const merchant_oid = "SUB" + Date.now(); // Benzersiz Sipariş Numarası
        const payment_amount = Math.round(finalPrice * 100); // PayTR kuruş (tam sayı) ister
        const basketName = plan.name + (validCouponCode ? ` (Kupon: ${validCouponCode})` : '');
        const user_basket = Buffer.from(JSON.stringify([
            [basketName, Math.round(finalPrice).toString(), 1]
        ])).toString('base64');

        // 2. Token Hesaplanacak Veriler (Sıralama kritiktir)
        const data = [
            process.env.PAYTR_MERCHANT_ID,
            user_ip,
            merchant_oid,
            email,
            payment_amount,
            user_basket,
            "1", // no_installment: Taksit kapalı
            "1", // max_installment
            "TRY",
            "0", // test_mode
            process.env.PAYTR_MERCHANT_SALT // PayTR kuralı: Salt en sonda olmalı
        ];

        // 3. Hash Oluşturuyoruz (UYARI: merchant_key ile şifrelenir)
        const paytr_token = generatePaytrToken(data, process.env.PAYTR_MERCHANT_KEY);

        // DEBUG: Gönderilen bilgileri konsola yazalım (Sorun çıkarsa bakmak için)
        console.log('--- PAYTR ISTEK DETAYI ---');
        console.log('Merchant OID:', merchant_oid);
        console.log('User IP:', user_ip);
        console.log('Email:', email);
        console.log('Token:', paytr_token);
        console.log('---------------------------');

        // 4. PayTR'ye İstek Gönderiyoruz
        const paytrRequest = {
            merchant_id: process.env.PAYTR_MERCHANT_ID,
            user_ip: user_ip,
            merchant_oid: merchant_oid,
            email: email,
            payment_amount: payment_amount,
            paytr_token: paytr_token,
            user_basket: user_basket,
            debug_on: 1, // Hata ayıklama açık (Test sırasında)
            no_installment: 1,
            max_installment: 1,
            user_name: user_name || 'Restoran Sahibi',
            user_address: user_address || 'Türkiye',
            user_phone: user_phone || '05000000000',
            merchant_ok_url: `${process.env.VITE_PANEL_URL || 'https://panel.kutyemek.com'}/admin/subscription?status=success`,
            merchant_fail_url: `${process.env.VITE_PANEL_URL || 'https://panel.kutyemek.com'}/admin/subscription?status=fail`,
            timeout_limit: 30, // 30 dakika
            currency: 'TRY',
            test_mode: 0,
            card_storage: 1 // Kart saklama özelliğini açıyoruz
        };

        const response = await axios.post('https://www.paytr.com/odeme/api/get-token',
            new URLSearchParams(paytrRequest).toString(),
            { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
        );

        if (response.data.status === 'success') {
            // Ödeme kaydını logluyoruz. Kupon kullanıldıysa onu da ekliyoruz.
            await db.promise().execute(
                'INSERT INTO payment_logs (restaurant_id, merchant_oid, amount, status, applied_coupon_code, wifi_ssid, wifi_password, whatsapp_selected, whatsapp_phone) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
                [restaurant_id, merchant_oid, finalPrice, 'pending', validCouponCode, wifi_ssid || null, wifi_password || null, whatsapp_selected ? 1 : 0, whatsapp_phone || null]
            );

            res.json({ status: 'success', token: response.data.token });
        } else {
            // PAYTR Hatasını Detaylı Gönder
            console.error('--- PAYTR API HATASI ---');
            console.error('Neden:', response.data.err_msg || response.data.reason);
            console.error('------------------------');
            res.status(400).json({
                status: 'failed',
                error: response.data.err_msg || response.data.reason || 'PayTR bilinmeyen hata döndürdü'
            });
        }

    } catch (err) {
        console.error('Ödeme başlatma hatası:', err.message);
        res.status(500).json({ error: 'Ödeme süreci başlatılamadı.' });
    }
};

/**
 * 2. Adım: PayTR Bildirim (Callback) İşleme.
 */
exports.handleCallback = async (req, res) => {
    console.log('🔔 [PAYTR] OKUMAYA HAZIR: Callback isteği geldi!');
    try {
        const params = req.body;
        console.log('📦 [PAYTR] GELEN DATA:', params);

        if (!params || Object.keys(params).length === 0) {
            console.error('⚠️ [PAYTR] HATA: Body boş geldi!');
            res.set('Content-Type', 'text/plain');
            return res.status(200).send('OK');
        }

        // 1. Hash Doğrulama
        const isValid = verifyPaytrHash(params, process.env.PAYTR_MERCHANT_KEY, process.env.PAYTR_MERCHANT_SALT);

        if (!isValid) {
            console.error('❌ [PAYTR] HATA: Hash doğrulaması başarısız!');
            res.set('Content-Type', 'text/plain');
            return res.status(200).send('OK');
        }

        const { merchant_oid, status, utoken, ctoken } = params;

        // 2. Ödeme başarılı mı?
        if (status === 'success') {
            try {
                // Restoran ID'sini ve kullanılan kuponu bul
                const [logs] = await db.promise().execute('SELECT * FROM payment_logs WHERE merchant_oid = ?', [merchant_oid]);

                if (logs && logs.length > 0) {
                    const restaurant_id = logs[0].restaurant_id;
                    const coupon_code = logs[0].applied_coupon_code;

                    if (coupon_code) {
                        // Eğer bu eski usul sabit Merkez Kuponu ise
                        if (!coupon_code.includes('-') || !['1', '2', '3', '4'].includes(coupon_code.split('-')[1])) {
                            await db.promise().execute(
                                'UPDATE subscription_coupons SET used_count = used_count + 1 WHERE code = ?',
                                [coupon_code]
                            );
                            console.log(`✅ [PAYTR] Merkez Sabit Kupon Kullanıldı: ${coupon_code}`);
                        } else {
                            // EĞER ÇÖZÜM ORTAĞI KODUYSA KOMİSYON DAĞIT
                            const baseCode = coupon_code.split('-')[0];
                            const paidAmount = parseFloat(logs[0].amount); // Ödenen gerçek tutar

                            const [partners] = await db.promise().execute('SELECT id, full_name, parent_id FROM partners WHERE base_code = ? AND status = ?', [baseCode, 'active']);

                            if (partners.length > 0) {
                                const seller = partners[0];

                                // 1. Kademe: Satan Bayi (%30)
                                const level1Earn = paidAmount * 0.30;
                                if (level1Earn > 0) {
                                    await db.promise().execute('UPDATE partners SET wallet_balance = wallet_balance + ?, total_earned = total_earned + ? WHERE id = ?', [level1Earn, level1Earn, seller.id]);
                                    await db.promise().execute(
                                        'INSERT INTO partner_transactions (partner_id, type, amount, restaurant_id, description) VALUES (?, ?, ?, ?, ?)',
                                        [seller.id, 'commission', level1Earn, restaurant_id, `Satış Komisyonu (%30): ${coupon_code}`]
                                    );
                                }

                                // 2. Kademe: Lider (%10)
                                if (seller.parent_id) {
                                    const [liderler] = await db.promise().execute('SELECT id, parent_id FROM partners WHERE id = ? AND status = ?', [seller.parent_id, 'active']);
                                    if (liderler.length > 0) {
                                        const lider = liderler[0];
                                        const level2Earn = paidAmount * 0.10;
                                        if (level2Earn > 0) {
                                            await db.promise().execute('UPDATE partners SET wallet_balance = wallet_balance + ?, total_earned = total_earned + ? WHERE id = ?', [level2Earn, level2Earn, lider.id]);
                                            await db.promise().execute(
                                                'INSERT INTO partner_transactions (partner_id, type, amount, restaurant_id, description) VALUES (?, ?, ?, ?, ?)',
                                                [lider.id, 'commission', level2Earn, restaurant_id, `Ekip Satışı (%10 Liderlik): ${seller.full_name}`]
                                            );
                                        }

                                        // 3. Kademe: Ana Lider (%10)
                                        if (lider.parent_id) {
                                            const [anaLiderler] = await db.promise().execute('SELECT id FROM partners WHERE id = ? AND status = ?', [lider.parent_id, 'active']);
                                            if (anaLiderler.length > 0) {
                                                const anaLider = anaLiderler[0];
                                                const level3Earn = paidAmount * 0.10;
                                                if (level3Earn > 0) {
                                                    await db.promise().execute('UPDATE partners SET wallet_balance = wallet_balance + ?, total_earned = total_earned + ? WHERE id = ?', [level3Earn, level3Earn, anaLider.id]);
                                                    await db.promise().execute(
                                                        'INSERT INTO partner_transactions (partner_id, type, amount, restaurant_id, description) VALUES (?, ?, ?, ?, ?)',
                                                        [anaLider.id, 'commission', level3Earn, restaurant_id, `Dev Takım Satışı (%10 Üst Liderlik): Ekibinizden ${seller.full_name}`]
                                                    );
                                                }
                                            }
                                        }
                                    }
                                }
                                console.log(`✅ [PAYTR] Çözüm Ortağı Komisyonları (3 Kademe) Dağıtıldı: ${coupon_code}`);
                            }
                        }
                    }
                    const starts_at = new Date();
                    const expires_at = new Date();
                    expires_at.setFullYear(expires_at.getFullYear() + 1);

                    // --- TRIAL KONTROLÜ ---
                    // DENE10 kuponu kullanılmışsa trial başlat, değilse normal active abonelik
                    const isTrial = coupon_code === 'DENE10';
                    const subStatus = isTrial ? 'trial' : 'active';
                    const trialOrderLimit = isTrial ? 10 : null;
                    const trialCouponCode = isTrial ? 'DENE10' : null;

                    await db.promise().execute(`
                        INSERT INTO subscriptions 
                        (restaurant_id, status, utoken, ctoken, starts_at, expires_at, next_billing_at, order_counter, trial_order_limit, trial_coupon_code) 
                        VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
                        ON DUPLICATE KEY UPDATE 
                        status = ?, utoken = ?, ctoken = ?, starts_at = ?, expires_at = ?, next_billing_at = ?,
                        order_counter = IF(VALUES(status) = 'trial', 0, order_counter),
                        trial_order_limit = VALUES(trial_order_limit),
                        trial_coupon_code = VALUES(trial_coupon_code)
                    `, [
                        restaurant_id, subStatus, utoken || null, ctoken || null, starts_at, expires_at, expires_at, trialOrderLimit, trialCouponCode,
                        subStatus, utoken || null, ctoken || null, starts_at, expires_at, expires_at
                    ]);
                    console.log(`✅ [PAYTR] Abonelik güncellendi: Restoran ${restaurant_id} (${subStatus.toUpperCase()})`);

                    // WiFi bilgilerini restaurant_settings tablosuna kaydet (fiş yazıcısı için)
                    if (logs[0].wifi_ssid && logs[0].wifi_password) {
                        try {
                            const [existingSettings] = await db.promise().execute(
                                'SELECT id FROM restaurant_settings WHERE restaurant_id = ? ORDER BY id ASC LIMIT 1',
                                [restaurant_id]
                            );
                            if (existingSettings.length > 0) {
                                await db.promise().execute(
                                    'UPDATE restaurant_settings SET printer_wifi_ssid = ?, printer_wifi_password = ? WHERE id = ? AND restaurant_id = ?',
                                    [logs[0].wifi_ssid, logs[0].wifi_password, existingSettings[0].id, restaurant_id]
                                );
                            } else {
                                await db.promise().execute(
                                    'INSERT INTO restaurant_settings (restaurant_id, printer_wifi_ssid, printer_wifi_password) VALUES (?, ?, ?)',
                                    [restaurant_id, logs[0].wifi_ssid, logs[0].wifi_password]
                                );
                            }
                            console.log(`📶 [PAYTR] WiFi bilgileri kaydedildi: Restoran ${restaurant_id}`);
                        } catch (wifiErr) {
                            console.error('⚠️ [PAYTR] WiFi kayıt hatası (ödeme etkilenmez):', wifiErr.message);
                        }
                    }

                    // WhatsApp sipariş bildirimini, ödeme adımındaki seçime göre kaydet
                    try {
                        const isWaSelected = logs[0].whatsapp_selected ? 1 : 0;
                        const waPhone = logs[0].whatsapp_phone || null;
                        const [existSettings] = await db.promise().execute(
                            'SELECT id FROM restaurant_settings WHERE restaurant_id = ? ORDER BY id ASC LIMIT 1',
                            [restaurant_id]
                        );
                        if (existSettings.length > 0) {
                            await db.promise().execute(
                                'UPDATE restaurant_settings SET whatsapp_order_notify = ?, whatsapp_phone = ? WHERE id = ? AND restaurant_id = ?',
                                [isWaSelected, waPhone, existSettings[0].id, restaurant_id]
                            );
                        } else {
                            await db.promise().execute(
                                'INSERT INTO restaurant_settings (restaurant_id, whatsapp_order_notify, whatsapp_phone) VALUES (?, ?, ?)',
                                [restaurant_id, isWaSelected, waPhone]
                            );
                        }
                        console.log(`📱 [PAYTR] WhatsApp sipariş bildirim seçimi kaydedildi (${isWaSelected}): Restoran ${restaurant_id}`);
                    } catch (waNotifyErr) {
                        console.error('⚠️ [PAYTR] WhatsApp bildirim ayarı hatası (ödeme etkilenmez):', waNotifyErr.message);
                    }

                    //  KUTBEYIN — Abonelik değişikliği event'ini fırlat
                    const brainBus = require('../events/brainBus');
                    brainBus.emit('subscription_changed', {
                        restaurantId: restaurant_id,
                        status: subStatus,
                        isTrial: isTrial
                    });
                }
            } catch (dbError) {
                console.error('❌ [PAYTR] Veritabanı İşlem Hatası:', dbError.message);
            }
        } else {
            // Ödeme başarısız
            try {
                await db.promise().execute(
                    'UPDATE payment_logs SET status = ?, error_msg = ? WHERE merchant_oid = ?',
                    ['failed', params.failed_reason_msg || 'Payment failed', merchant_oid]
                );
            } catch (dbError) {
                console.error('❌ [PAYTR] Başarısız Ödeme Loglama Hatası:', dbError.message);
            }
        }

        // 3. PayTR Yanıtı (Saf metin)
        res.set('Content-Type', 'text/plain');
        return res.status(200).send('OK');

    } catch (err) {
        console.error('💣 [PAYTR] Kritik Callback Hatası:', err.message);
        res.set('Content-Type', 'text/plain');
        return res.status(200).send('OK');
    }
};

/**
 * 3. Adım: Abonelik Durumunu Sorgular.
 */
exports.getStatus = async (req, res) => {
    try {
        const restaurant_id = req.restaurant_id;
        const [rows] = await db.promise().execute(
            'SELECT * FROM subscriptions WHERE restaurant_id = ?',
            [restaurant_id]
        );
        if (rows.length > 0) {
            const sub = rows[0];

            // Trial durumu için ekstra bilgi ekle (sipariş limiti bazlı)
            if (sub.status === 'trial') {
                const counter = parseInt(sub.order_counter) || 0;
                const limit = parseInt(sub.trial_order_limit) || 10;
                sub.trial_remaining = Math.max(0, limit - counter);
                sub.trial_progress = `${counter}/${limit}`;
            }

            // Zaman tabanlı trial durumu için ekstra bilgi ekle
            if (sub.status === 'trial_time' && sub.trial_expires_at) {
                const now = new Date();
                const expiresAt = new Date(sub.trial_expires_at);
                const remainingMs = expiresAt.getTime() - now.getTime();
                const remainingDays = Math.max(0, Math.ceil(remainingMs / (1000 * 60 * 60 * 24)));

                sub.trial_remaining_days = remainingDays;
                sub.trial_is_expired = remainingDays <= 0;
                sub.trial_type_info = 'time_based';
            }

            // Daha önce trial kullanılmış mı? (banner için)
            sub.has_used_trial = sub.trial_coupon_code !== null && sub.trial_coupon_code !== undefined;
            sub.has_used_time_trial = sub.trial_code_used !== null && sub.trial_code_used !== undefined;

            res.json(sub);
        } else {
            res.json({ status: 'none', trial_order_limit: 10 });
        }
    } catch (err) {
        res.status(500).json({ error: 'Abonelik durumu sorgulanamadı.' });
    }
};

/**
 * 4. Adım: Abonelik Planlarını Getirir.
 */
exports.getPlans = async (req, res) => {
    try {
        const [rows] = await db.promise().execute('SELECT id, name, price, duration_months FROM subscription_plans WHERE active = 1 ORDER BY price ASC');
        res.json({ status: 'success', data: rows });
    } catch (err) {
        console.error("Plan getirme hatası:", err.message);
        res.status(500).json({ error: 'Planlar sorgulanamadı.' });
    }
};

/**
 * 5. Adım: Tedarikçi Kuponunu Doğrular.
 */
exports.validateCoupon = async (req, res) => {
    try {
        const { couponCode } = req.body;
        if (!couponCode) return res.status(400).json({ error: 'Kupon kodu gerekli.' });

        const [rows] = await db.promise().execute(
            'SELECT * FROM subscription_coupons WHERE code = ? AND active = 1 AND (expires_at IS NULL OR expires_at > NOW()) AND (usage_limit IS NULL OR used_count < usage_limit)',
            [couponCode]
        );

        if (rows.length > 0) {
            const coupon = rows[0];
            return res.json({
                status: 'success',
                data: {
                    code: coupon.code,
                    partner_name: coupon.partner_name,
                    discount_type: coupon.discount_type,
                    discount_amount: coupon.discount_amount
                }
            });
        }

        // 2. Bayi Kodu (Partner Code) Kontrolü
        if (couponCode.includes('-')) {
            const parts = couponCode.split('-');
            const baseCode = parts[0];
            const tierStr = parts[1];

            if (['1', '2', '3', '4'].includes(tierStr)) {
                // Partner tablosuna bak
                const [partners] = await db.promise().execute('SELECT full_name, status FROM partners WHERE base_code = ?', [baseCode]);

                if (partners.length > 0 && partners[0].status === 'active') {
                    const tier = parseInt(tierStr);
                    const maxDiscount = process.env.MAX_PARTNER_DISCOUNT ? parseInt(process.env.MAX_PARTNER_DISCOUNT) : 40;
                    const tierStep = maxDiscount / 4;
                    const calculatedDiscount = Math.round((tier * tierStep) / 5) * 5 || (tier * 5);

                    return res.json({
                        status: 'success',
                        data: {
                            code: couponCode,
                            partner_name: partners[0].full_name + " (Çözüm Ortağı)",
                            discount_type: 'percentage',
                            discount_amount: calculatedDiscount
                        }
                    });
                }
            }
        }

        res.status(404).json({ error: 'Geçersiz veya kullanım limiti dolmuş kupon kodu.' });
    } catch (err) {
        console.error("Kupon doğrulama hatası:", err.message);
        res.status(500).json({ error: 'Kupon doğrulanamadı.' });
    }
};
