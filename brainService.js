/**
 * 🧠 KutBeyin — Brain Service (Orkestrasyon Katmanı)
 * 
 * Her mesaj gönderilmeden önce kontrol zincirini çalıştırır:
 * 1. Sessiz saat kontrolü (22:00 - 09:00 arası mesaj gitmez)
 * 2. Hedef bazlı günlük/saatlik limit kontrolü
 * 3. Cooldown kontrolü (aynı kural → aynı kişi → son X saat)
 * 4. Max tekrar kontrolü
 * 5. Günlük kural limiti kontrolü
 * 6. Mesaj template doldurma
 * 7. Kanal çözümleme ve gönderim
 * 8. Gönderim loglama
 */

const db = require('../config/db');
const { BRAIN_RULES } = require('../scripts/brainRules/seedRules');
const { sendMessage } = require('./whatsappService');

/**
 * Sessiz saat kontrolü (gece 22:00 - sabah 09:00 arası mesaj gitmez)
 * 
 * @param {string} targetType - 'restaurant', 'customer', 'team'
 * @returns {Promise<boolean>} true = sessiz saat, mesaj gönderilmemeli
 */
async function isQuietHour(targetType) {
  try {
    const [rows] = await db.promise().query(
      'SELECT quiet_start, quiet_end FROM brain_target_limits WHERE target_type = ?',
      [targetType]
    );

    if (!rows || rows.length === 0) return false;

    const { quiet_start, quiet_end } = rows[0];
    if (!quiet_start || !quiet_end) return false;

    // Sunucu saati UTC olsa bile her zaman Türkiye saatine göre (UTC+3) kontrol et
    const now = new Date();
    let trHour = now.getUTCHours() + 3;
    if (trHour >= 24) trHour -= 24;
    const currentMinutes = trHour * 60 + now.getUTCMinutes();

    // quiet_start ve quiet_end'i dakikaya çevir
    const [startH, startM] = quiet_start.split(':').map(Number);
    const [endH, endM] = quiet_end.split(':').map(Number);
    const startMinutes = startH * 60 + startM;
    const endMinutes = endH * 60 + endM;

    // Gece yarısını geçen sessiz saat (22:00 → 09:00)
    if (startMinutes > endMinutes) {
      return currentMinutes >= startMinutes || currentMinutes < endMinutes;
    }
    // Normal aralık
    return currentMinutes >= startMinutes && currentMinutes < endMinutes;

  } catch (error) {
    console.error('[BrainService] Sessiz saat kontrol hatası:', error.message);
    return false;
  }
}

/**
 * Hedef bazlı günlük mesaj limitini kontrol eder
 * 
 * @param {string} targetType - 'restaurant', 'customer', 'team'
 * @param {number} targetId - Hedef ID
 * @returns {Promise<boolean>} true = limit aşıldı, mesaj gönderilmemeli
 */
async function isTargetLimitExceeded(targetType, targetId) {
  try {
    // Limiti çek
    const [limitRows] = await db.promise().query(
      'SELECT max_daily, max_hourly FROM brain_target_limits WHERE target_type = ?',
      [targetType]
    );

    if (!limitRows || limitRows.length === 0) return false;

    const { max_daily, max_hourly } = limitRows[0];

    // Bugün bu hedefe kaç mesaj gitti?
    const [dailyRows] = await db.promise().query(
      `SELECT COUNT(*) as cnt FROM brain_notifications 
       WHERE target_type = ? AND target_id = ? AND status = 'sent'
       AND created_at >= CURDATE()`,
      [targetType, targetId]
    );

    if (dailyRows[0].cnt >= max_daily) {
      console.log(`[BrainService] Günlük limit aşıldı (${targetType}:${targetId}) ${dailyRows[0].cnt}/${max_daily}`);
      return true;
    }

    // Son 1 saatte kaç mesaj gitti?
    const [hourlyRows] = await db.promise().query(
      `SELECT COUNT(*) as cnt FROM brain_notifications 
       WHERE target_type = ? AND target_id = ? AND status = 'sent'
       AND created_at >= DATE_SUB(NOW(), INTERVAL 1 HOUR)`,
      [targetType, targetId]
    );

    if (hourlyRows[0].cnt >= max_hourly) {
      console.log(`[BrainService] Saatlik limit aşıldı (${targetType}:${targetId}) ${hourlyRows[0].cnt}/${max_hourly}`);
      return true;
    }

    return false;

  } catch (error) {
    console.error('[BrainService] Hedef limit kontrol hatası:', error.message);
    return false; // Hata durumunda mesajı engelleme
  }
}

/**
 * Cooldown kontrolü — aynı kural, aynı hedef, son X saat içinde gönderilmiş mi?
 * 
 * @param {string} ruleKey - Kural anahtarı
 * @param {string} targetType - Hedef tipi
 * @param {number} targetId - Hedef ID
 * @param {number} cooldownHours - Bekleme süresi (saat)
 * @returns {Promise<boolean>} true = cooldown aktif, mesaj gönderilmemeli
 */
async function isCooldownActive(ruleKey, targetType, targetId, cooldownHours) {
  try {
    const [rows] = await db.promise().query(
      `SELECT COUNT(*) as cnt FROM brain_notifications
       WHERE rule_key = ? AND target_type = ? AND target_id = ? AND status = 'sent'
       AND created_at >= DATE_SUB(NOW(), INTERVAL ? HOUR)`,
      [ruleKey, targetType, targetId, cooldownHours]
    );

    return rows[0].cnt > 0;

  } catch (error) {
    console.error('[BrainService] Cooldown kontrol hatası:', error.message);
    return false;
  }
}

/**
 * Max tekrar kontrolü — bu kural bu hedefe toplam kaç kez gönderilmiş?
 * 
 * @param {string} ruleKey - Kural anahtarı
 * @param {string} targetType - Hedef tipi
 * @param {number} targetId - Hedef ID
 * @param {number|null} maxRepeat - Max tekrar (null = sınırsız)
 * @returns {Promise<{exceeded: boolean, count: number}>}
 */
async function checkMaxRepeat(ruleKey, targetType, targetId, maxRepeat) {
  if (maxRepeat === null || maxRepeat === undefined) {
    return { exceeded: false, count: 0 };
  }

  try {
    const [rows] = await db.promise().query(
      `SELECT COUNT(*) as cnt FROM brain_notifications
       WHERE rule_key = ? AND target_type = ? AND target_id = ? AND status = 'sent'`,
      [ruleKey, targetType, targetId]
    );

    const count = rows[0].cnt;
    return { exceeded: count >= maxRepeat, count };

  } catch (error) {
    console.error('[BrainService] Max repeat kontrol hatası:', error.message);
    return { exceeded: false, count: 0 };
  }
}

/**
 * Günlük kural limiti kontrolü — bu kural bugün toplam kaç kez tetiklendi?
 * 
 * @param {string} ruleKey - Kural anahtarı
 * @param {number} maxPerDay - Günlük max gönderim sayısı
 * @returns {Promise<boolean>} true = limit aşıldı
 */
async function isRuleDailyLimitExceeded(ruleKey, maxPerDay) {
  try {
    const [rows] = await db.promise().query(
      `SELECT COUNT(*) as cnt FROM brain_notifications
       WHERE rule_key = ? AND status = 'sent' AND created_at >= CURDATE()`,
      [ruleKey]
    );

    return rows[0].cnt >= maxPerDay;

  } catch (error) {
    console.error('[BrainService] Kural günlük limit kontrol hatası:', error.message);
    return false;
  }
}

/**
 * Mesaj template'ini doldurur — {variable} formatındaki değişkenleri gerçek değerlerle değiştirir
 * 
 * @param {string} template - Mesaj şablonu
 * @param {Object} data - Değişken verileri
 * @returns {string} Doldurulmuş mesaj
 */
function fillTemplate(template, data = {}) {
  let message = template;

  for (const [key, value] of Object.entries(data)) {
    const regex = new RegExp(`\\{${key}\\}`, 'g');
    message = message.replace(regex, value !== null && value !== undefined ? String(value) : '');
  }

  // Doldurulmamış {variable} kalıntılarını temizle (Bug #5 fix)
  message = message.replace(/\{[a-zA-Z_]+\}/g, '').replace(/\s{2,}/g, ' ').trim();

  return message;
}

/**
 * Gönderim logunu veritabanına kaydeder
 */
async function logNotification(ruleId, ruleKey, targetType, targetId, restaurantId, phone, channelUsed, messageSent, status, errorMessage = null, metadata = null) {
  try {
    // Veritabanı ENUM('whatsapp','sms','push','panel') kısıtlamasına uyum sağla
    let cleanChannel = channelUsed;
    if (targetType === 'team') {
      cleanChannel = 'panel';
    } else {
      const allowedChannels = ['whatsapp', 'sms', 'push', 'panel'];
      if (!allowedChannels.includes(cleanChannel)) {
        cleanChannel = 'whatsapp'; // varsayılan kanal
      }
    }

    await db.promise().query(
      `INSERT INTO brain_notifications 
       (rule_id, rule_key, target_type, target_id, restaurant_id, phone, channel_used, message_sent, status, error_message, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [ruleId, ruleKey, targetType, targetId, restaurantId, phone, cleanChannel, messageSent, status, errorMessage, metadata ? JSON.stringify(metadata) : null]
    );
  } catch (error) {
    console.error('[BrainService] Log kayıt hatası:', error.message);
  }
}

/**
 * Ekibe (KutPanel) bildirim gönderir
 */
async function notifyTeam(ruleKey, message, metadata = null) {
  try {
    await logNotification(null, ruleKey, 'team', null, null, null, 'panel', message, 'sent', null, metadata);
    console.log(`[BrainService] Ekip bildirimi: ${message.substring(0, 80)}...`);
  } catch (error) {
    console.error('[BrainService] Ekip bildirim hatası:', error.message);
  }
}

/**
 *  ANA KONTROL ZİNCİRİ
 * Bir kural tetiklendiğinde her hedef için bu fonksiyon çalışır.
 * 
 * @param {Object} rule - Kural objesi (brain_rules tablosundan)
 * @param {Object} target - Hedef objesi { target_id, restaurant_id, target_name, phone }
 * @param {Object} templateData - Template doldurma verileri
 * @returns {Promise<{sent: boolean, reason?: string}>}
 */
async function processTarget(rule, target, templateData = {}, options = {}) {
  const { id: ruleId, rule_key, target_type, cooldown_hours, max_repeat, escalate_on_max, max_per_day, message_template, channel } = rule;
  const { target_id, restaurant_id, phone, slug } = target;

  if (!target.restaurant_url && target_id) {
    target.restaurant_url = slug ? `${slug}.kutyemek.com` : `kutyemek.com/r/${target_id}`;
  }

  // DB'de olmayan alanları statik kural tanımından (BRAIN_RULES) yükle
  const staticRule = BRAIN_RULES.find(r => r.rule_key === rule_key);
  if (staticRule) {
    rule.meta_template_name = staticRule.meta_template_name || null;
    rule.meta_template_params = staticRule.meta_template_params || [];
  }

  // 1. Sessiz saat kontrolü (test modunda bypass edilebilir — Bug #4 fix)
  if (target_type !== 'team' && !options.skipQuietHour) {
    const quiet = await isQuietHour(target_type);
    if (quiet) {
      console.log(`[BrainService] Sessiz saat — ${rule_key} → ${target_type}:${target_id} atlanıyor.`);
      await logNotification(ruleId, rule_key, target_type, target_id, restaurant_id, phone, channel || 'auto', '', 'skipped', 'Sessiz saat');
      return { sent: false, reason: 'quiet_hour' };
    }
  }

  // Test modunda tüm limitleri atla
  if (!options.skipLimits) {
    // 2. Max tekrar kontrolü (En kalıcı engel, log atmaz)
    if (target_id) {
      const { exceeded, count } = await checkMaxRepeat(rule_key, target_type, target_id, max_repeat);
      if (exceeded) {
        console.log(`[BrainService] Max tekrar aşıldı — ${rule_key} → ${target_type}:${target_id} (${count}/${max_repeat})`);

        // Escalate: Ekibe bildirim gönder
        if (escalate_on_max) {
          const displayName = target.restaurant_name || target.target_name || `${target_type}:${target_id}`;
          await notifyTeam(rule_key, `⚠️ "${rule.rule_name}" aşaması ${displayName} için max sınıra ulaştı (${count}/${max_repeat}). Manuel destek/arama gerekebilir.`, {
            rule_key, target_type, target_id, restaurant_id, repeat_count: count
          });
        }

        return { sent: false, reason: 'max_repeat_exceeded' };
      }
    }

    // 3. Cooldown kontrolü (Geçici engel, log atmaz)
    if (target_id && cooldown_hours > 0) {
      const onCooldown = await isCooldownActive(rule_key, target_type, target_id, cooldown_hours);
      if (onCooldown) {
        console.log(`[BrainService] Cooldown aktif — ${rule_key} → ${target_type}:${target_id}`);
        return { sent: false, reason: 'cooldown' };
      }
    }

    // 4. Hedef bazlı günlük/saatlik limit (Genel engel, log atar çünkü kural geçse de sisteme takılıyor)
    if (target_id) {
      const limitExceeded = await isTargetLimitExceeded(target_type, target_id);
      if (limitExceeded) {
        await logNotification(ruleId, rule_key, target_type, target_id, restaurant_id, phone, channel || 'auto', '', 'skipped', 'Hedef limiti aşıldı');
        return { sent: false, reason: 'target_limit_exceeded' };
      }
    }

    // 5. Kural günlük limiti
    const ruleLimitExceeded = await isRuleDailyLimitExceeded(rule_key, max_per_day);
    if (ruleLimitExceeded) {
      console.log(`[BrainService] Kural günlük limiti aşıldı — ${rule_key}`);
      return { sent: false, reason: 'rule_daily_limit' };
    }
  } else {
    console.log(`[BrainService] 🧪 Test modu — limitler atlanıyor (${rule_key} → ${target_type}:${target_id})`);
  }

  // 6. Haftalık rapor karşılaştırma metni oluştur
  let comparison_text = 'Bu hafta da harika işler çıkarın! 💪'; // Varsayılan fallback (Bug #6 fix)
  if (target.orders !== undefined && target.last_week_orders !== undefined) {
    const thisWeek = parseInt(target.orders) || 0;
    const lastWeek = parseInt(target.last_week_orders) || 0;
    if (lastWeek === 0 && thisWeek > 0) {
      comparison_text = 'Geçen haftaya göre harika bir başlangıç! 🚀';
    } else if (thisWeek > lastWeek) {
      comparison_text = `Geçen haftaya göre %${Math.round(((thisWeek - lastWeek) / lastWeek) * 100)} artış! 🎉`;
    } else if (thisWeek < lastWeek) {
      comparison_text = `Geçen haftaya göre %${Math.round(((lastWeek - thisWeek) / lastWeek) * 100)} düşüş. Kampanya oluşturmayı deneyin!`;
    } else {
      comparison_text = 'Geçen haftayla aynı performans. Devam edin! 💪';
    }
  }

  // 6b. Dinamik template verileri (DB'den çekilir)
  let dynamicData = {};
  try {
    // Team kuralları: {count}, {new_restaurants}, {total_orders_today}, {revenue_today}
    if (target_type === 'team') {
      const [riskCount] = await db.promise().query(
        `SELECT COUNT(*) as cnt FROM restaurants r 
         JOIN subscriptions s ON r.id = s.restaurant_id 
         WHERE s.status IN ('active','trial') 
         AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.restaurant_id = r.id AND o.order_time >= DATE_SUB(NOW(), INTERVAL 7 DAY))`
      );
      const [todayStats] = await db.promise().query(
        `SELECT COUNT(*) as total_orders_today, COALESCE(SUM(total_amount),0) as revenue_today FROM orders WHERE order_time >= CURDATE()`
      );
      const [newRest] = await db.promise().query(
        `SELECT COUNT(*) as cnt FROM restaurants WHERE created_at >= CURDATE()`
      );
      dynamicData.count = riskCount[0]?.cnt || 0;
      dynamicData.new_restaurants = newRest[0]?.cnt || 0;
      dynamicData.total_orders_today = todayStats[0]?.total_orders_today || 0;
      dynamicData.revenue_today = todayStats[0]?.revenue_today || '0.00';
      // Template alias'ları ({orders}, {revenue} olarak da kullanılabilsin)
      dynamicData.orders = dynamicData.total_orders_today;
      dynamicData.revenue = dynamicData.revenue_today;
    }

    // Müşteri kuralları: {amount} (cashback kazancı)
    if (target_type === 'customer' && rule_key.includes('cashback_earned')) {
      // Önce event data'daki amount'u kullan (sipariş anında hesaplanan cashback)
      const eventAmount = parseFloat(templateData.amount || 0);
      if (eventAmount > 0) {
        dynamicData.amount = eventAmount.toFixed(2);
      } else if (target.target_id && restaurant_id) {
        // Fallback: Son kazanılan cashback'i DB'den çek
        const [lastTx] = await db.promise().query(
          `SELECT amount FROM loyalty_transactions 
           WHERE wallet_id IN (SELECT id FROM user_wallets WHERE user_id = ? AND restaurant_id = ?) 
           AND type = 'EARN' ORDER BY created_at DESC LIMIT 1`,
          [target.target_id, restaurant_id]
        );
        dynamicData.amount = lastTx[0]?.amount || '0.00';
      } else {
        dynamicData.amount = '0.00';
      }
    }
  } catch (dynErr) {
    console.warn('[BrainService] Dinamik veri hatası:', dynErr.message);
  }

  // DEBUG LOG EKLENDI: Çözüm analizi için oran parametresi loglanıyor
  console.log(`[BrainService] 🐛 DEBUG: Template doldurulurken 'rate' değeri: ${target.rate !== undefined ? target.rate : 'BULUNAMADI'}`);

  // 7. Template doldur
  const filledMessage = fillTemplate(message_template, {
    ...target,
    ...templateData,
    ...dynamicData,
    target_name: target.target_name || '',
    restaurant_name: target.restaurant_name || target.target_name || '',
    city: target.city || '',
    district: target.district || '',
    comparison_text,
  });

  // 7. Kanal çözümleme ve gönderim
  if (target_type === 'team') {
    await notifyTeam(rule_key, filledMessage, { rule_key, target_id, restaurant_id });
    return { sent: true, channel: 'panel' };
  }

  // Özel Meta WhatsApp şablonu (template) ayarları
  const sendMessageOptions = {};
  if (rule.meta_template_name) {
    sendMessageOptions.templateName = rule.meta_template_name;

    const allVars = {
      ...target,
      ...templateData,
      ...dynamicData,
      target_name: target.target_name || '',
      restaurant_name: target.restaurant_name || target.target_name || '',
      city: target.city || '',
      district: target.district || '',
      comparison_text,
    };

    const paramsList = rule.meta_template_params || [];
    sendMessageOptions.bodyParams = paramsList.map(p => {
      // {coupon_amount} -> allVars['coupon_amount']
      return allVars[p] !== undefined && allVars[p] !== null ? String(allVars[p]) : '';
    });
  }

  const result = await sendMessage(phone, filledMessage, channel === 'auto' ? 'auto' : channel, sendMessageOptions);

  // 8. Logla
  const status = result.success ? 'sent' : 'failed';
  await logNotification(ruleId, rule_key, target_type, target_id, restaurant_id, phone, result.channel || 'whatsapp', filledMessage, status, result.error || null);

  if (result.success) {
    console.log(`[BrainService] ✅ ${rule_key} → ${target_type}:${target_id} (${result.channel})`);
  }

  return { sent: result.success, channel: result.channel, reason: result.error };
}

/**
 * Event verilerinden hedef objesini çözümler.
 * Telefon ve restoran adı bilgisi yoksa DB'den çeker.
 * 
 * @param {string} targetType - 'restaurant', 'customer', 'team'
 * @param {Object} eventData - Event verileri
 * @returns {Promise<Object|null>} Çözümlenmiş hedef objesi
 */
async function resolveTarget(targetType, eventData) {
  try {
    // target_id: restaurant ise restaurantId, customer ise userId
    let targetId;
    if (targetType === 'customer') {
      targetId = eventData.userId || null;
    } else if (targetType === 'team') {
      targetId = null;
    } else {
      targetId = eventData.restaurantId || null;
    }

    const target = {
      target_id: targetId,
      restaurant_id: eventData.restaurantId || null,
      target_name: eventData.restaurantName || eventData.userName || '',
      phone: eventData.phone || null
    };

    // Telefon yoksa DB'den çek
    if (!target.phone && target.target_id) {
      if (targetType === 'restaurant') {
        const [staffRows] = await db.promise().query(
          `SELECT phone FROM staff WHERE restaurant_id = ? AND role = 'admin' LIMIT 1`,
          [target.target_id]
        );
        if (staffRows && staffRows.length > 0) {
          target.phone = staffRows[0].phone;
        }
      } else if (targetType === 'customer') {
        const [userRows] = await db.promise().query(
          `SELECT phone, full_name FROM users WHERE id = ? LIMIT 1`,
          [target.target_id]
        );
        if (userRows && userRows.length > 0) {
          target.phone = userRows[0].phone;
          target.target_name = target.target_name || userRows[0].full_name;
        }
      }
    }

    // Restoran adını ve şehir bilgisini çek (template için)
    if (eventData.restaurantId && !target.restaurant_name) {
      const [restRows] = await db.promise().query(
        `SELECT COALESCE(sc.business_name, r.name) AS restaurant_name,
                sc.address_il AS city, sc.address_ilce AS district,
                r.slug
         FROM restaurants r 
         LEFT JOIN setup_config sc ON r.id = sc.restaurant_id 
         WHERE r.id = ? LIMIT 1`,
        [eventData.restaurantId]
      );
      if (restRows && restRows.length > 0) {
        target.restaurant_name = restRows[0].restaurant_name;
        target.city = restRows[0].city || '';
        target.district = restRows[0].district || '';

        // Generate restaurant_url using slug if available
        if (restRows[0].slug) {
          target.restaurant_url = `${restRows[0].slug}.kutyemek.com`;
        } else {
          target.restaurant_url = `kutyemek.com/r/${eventData.restaurantId}`;
        }
      }
    }

    return target;
  } catch (error) {
    console.error('[BrainService] Hedef çözümleme hatası:', error.message);
    return null;
  }
}

module.exports = {
  isQuietHour,
  isTargetLimitExceeded,
  isCooldownActive,
  checkMaxRepeat,
  isRuleDailyLimitExceeded,
  fillTemplate,
  logNotification,
  notifyTeam,
  processTarget,
  resolveTarget
};