/**
 * Trial Code Service
 * ──────────────────
 * Sorumluluk: İş mantığı orchestration — Repository + Validator birleştirme
 * Prensip: Dependency Inversion — Repository'lere bağımlı, DB'ye direkt erişmez
 * 
 * Bu katman HTTP'den bağımsızdır (req/res bilmez).
 * Controller'dan çağrılır, cron job'lardan da çağrılabilir.
 */
const trialCodeRepo = require('../repositories/trialCodeRepository');
const trialSubRepo = require('../repositories/trialSubscriptionRepository');
const trialCodeValidator = require('../validators/trialCodeValidator');

/**
 * Hata türleri — Controller'ların doğru HTTP status dönmesi için
 */
const ERROR_TYPES = Object.freeze({
    VALIDATION: 'VALIDATION',     // 400
    NOT_FOUND: 'NOT_FOUND',       // 404
    CONFLICT: 'CONFLICT',         // 409
    FORBIDDEN: 'FORBIDDEN',       // 403
});

class TrialCodeService {

    /**
     * Deneme kodunu aktifleştirir — Ana akış
     * 
     * Akış: Format doğrula → Kodu bul → Aktiflik kontrol → Restoran uygunluk → Abonelik oluştur
     * 
     * @param {number} restaurantId - Restoran ID
     * @param {string} code - Deneme kodu
     * @returns {{ success: boolean, data?: Object, error?: string }}
     */
    async activateTrialCode(restaurantId, code, options = {}) {
        const { whatsapp_selected = 0, whatsapp_phone = null } = options;

        // 1. Format doğrulaması
        const formatResult = trialCodeValidator.validateCodeFormat(code);
        if (!formatResult.isValid) {
            return { success: false, errorType: ERROR_TYPES.VALIDATION, error: formatResult.error };
        }

        // 2. Kodu veritabanından bul
        const normalizedCode = code.trim().toUpperCase();
        const trialCode = await trialCodeRepo.findByCode(normalizedCode);

        // 3. Kodun aktifliğini ve limitini kontrol et
        const availabilityResult = trialCodeValidator.validateCodeAvailability(trialCode);
        if (!availabilityResult.isValid) {
            return { success: false, errorType: ERROR_TYPES.NOT_FOUND, error: availabilityResult.error };
        }

        // 4. Restoranın deneme hakkını kontrol et
        const hasUsedBefore = await trialSubRepo.hasUsedTimeTrial(restaurantId);
        const existingSub = await trialSubRepo.findByRestaurantId(restaurantId);
        
        const eligibilityResult = trialCodeValidator.validateRestaurantEligibility(hasUsedBefore, existingSub);
        if (!eligibilityResult.isValid) {
            return { success: false, errorType: ERROR_TYPES.CONFLICT, error: eligibilityResult.error };
        }

        // 5. Tarih hesaplaması (Service sorumluluğu — Repository'ye hazır tarih geçer)
        const startsAt = new Date();
        const expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + trialCode.trial_duration);

        // 6. Abonelik oluştur/güncelle
        const subscription = await trialSubRepo.createOrUpdateTimeTrial(restaurantId, {
            trialCode: normalizedCode,
            startsAt,
            expiresAt
        });

        // 7. Kod kullanım sayısını artır
        await trialCodeRepo.incrementUsage(trialCode.id);

        // 8. WhatsApp sipariş bildirim tercihini kaydet (ücretsiz seçenek)
        if (whatsapp_selected) {
            await this._saveWhatsAppPreference(restaurantId, whatsapp_selected, whatsapp_phone);
        }

        // 9. Event fırlat (varsa)
        this._emitTrialActivated(restaurantId, normalizedCode, expiresAt);

        console.log(`✅ [TRIAL] Deneme kodu aktifleştirildi: ${normalizedCode} → Restoran #${restaurantId} (${trialCode.trial_duration} gün, WhatsApp: ${whatsapp_selected ? 'Evet' : 'Hayır'})`);

        return {
            success: true,
            data: {
                restaurantId,
                status: 'trial_time',
                trialCode: normalizedCode,
                durationDays: trialCode.trial_duration,
                startsAt,
                expiresAt
            }
        };
    }

    /**
     * Restoranın deneme durumunu sorgular
     * @param {number} restaurantId
     * @returns {Object}
     */
    async getTrialStatus(restaurantId) {
        const subscription = await trialSubRepo.findByRestaurantId(restaurantId);

        if (!subscription) {
            return {
                hasSubscription: false,
                status: 'none',
                hasUsedTrial: false
            };
        }

        const hasUsedTrial = await trialSubRepo.hasUsedTimeTrial(restaurantId);
        const isTimeTrial = subscription.trial_type === 'time_based';

        const result = {
            hasSubscription: true,
            status: subscription.status,
            startsAt: subscription.starts_at,
            expiresAt: subscription.expires_at,
            hasUsedTrial,
            trialType: subscription.trial_type,
            trialCodeUsed: subscription.trial_code_used
        };

        // Zaman tabanlı deneme ise ek bilgiler
        if (isTimeTrial && subscription.trial_expires_at) {
            const now = new Date();
            const expiresAt = new Date(subscription.trial_expires_at);
            const remainingMs = expiresAt.getTime() - now.getTime();
            const remainingDays = Math.max(0, Math.ceil(remainingMs / (1000 * 60 * 60 * 24)));

            result.trialExpiresAt = subscription.trial_expires_at;
            result.trialRemainingDays = remainingDays;
            result.trialIsExpired = remainingDays <= 0;
            result.trialProgress = `${Math.max(0, (subscription.trial_duration || 60) - remainingDays)}/${subscription.trial_duration || 60} gün`;
        }

        return result;
    }

    /**
     * Süresi dolan denemeleri otomatik expire eder (Cron tarafından çağrılır)
     * @returns {{ expiredCount: number, warnings: Array }}
     */
    async checkAndExpireTrials() {
        const expiredCount = await trialSubRepo.expireOverdueTrials();

        if (expiredCount > 0) {
            console.log(`⏰ [TRIAL-CRON] ${expiredCount} deneme aboneliği süresi dolduğu için expired yapıldı.`);
        }

        // Yakında dolacakları kontrol et (7, 3, 1 gün kala)
        const warnings = [];
        for (const daysLeft of [7, 3, 1]) {
            const expiring = await trialSubRepo.findExpiringTrials(daysLeft);
            if (expiring.length > 0) {
                console.log(`⚠️ [TRIAL-CRON] ${expiring.length} restoranın denemesi ${daysLeft} gün içinde dolacak.`);
                warnings.push({ daysLeft, restaurants: expiring });
            }
        }

        return { expiredCount, warnings };
    }

    /**
     * Admin: Deneme süresini uzatır
     * @param {number} restaurantId
     * @param {number} extraDays
     * @returns {{ success: boolean, data?: Object, error?: string }}
     */
    async extendTrial(restaurantId, extraDays) {
        if (!extraDays || extraDays < 1 || extraDays > 365) {
            return { success: false, errorType: ERROR_TYPES.VALIDATION, error: 'Uzatma süresi 1-365 gün arasında olmalıdır.' };
        }

        const updated = await trialSubRepo.extendTrial(restaurantId, extraDays);
        if (!updated) {
            return { success: false, errorType: ERROR_TYPES.NOT_FOUND, error: 'Bu restoran için zaman tabanlı deneme aboneliği bulunamadı.' };
        }

        console.log(`✅ [TRIAL] Restoran #${restaurantId} denemesi ${extraDays} gün uzatıldı.`);

        return {
            success: true,
            data: {
                restaurantId,
                newExpiresAt: updated.trial_expires_at,
                extraDays
            }
        };
    }

    /**
     * Admin: Yeni deneme kodu oluşturur
     * @param {Object} codeData - { code, trial_duration, max_usage, notes, created_by }
     * @returns {{ success: boolean, data?: Object, error?: string }}
     */
    async createTrialCode(codeData) {
        // Doğrulama
        const validationResult = trialCodeValidator.validateCodeCreation(codeData);
        if (!validationResult.isValid) {
            return { success: false, error: validationResult.error };
        }

        // Kod zaten var mı?
        const normalizedCode = codeData.code.trim().toUpperCase();
        const existing = await trialCodeRepo.findByCode(normalizedCode);
        if (existing) {
            return { success: false, errorType: ERROR_TYPES.CONFLICT, error: `'${normalizedCode}' kodu zaten mevcut.` };
        }

        const created = await trialCodeRepo.create({
            ...codeData,
            code: normalizedCode
        });

        console.log(`✅ [TRIAL] Yeni deneme kodu oluşturuldu: ${normalizedCode} (${codeData.trial_duration || 60} gün)`);

        return { success: true, data: created };
    }

    /**
     * Admin: Tüm kodları listeler
     * @returns {Array}
     */
    async listAllCodes() {
        return trialCodeRepo.findAll();
    }

    /**
     * Admin: Kodu devre dışı bırakır
     * @param {string} code
     * @returns {{ success: boolean, error?: string }}
     */
    async deactivateCode(code) {
        const result = await trialCodeRepo.deactivate(code.toUpperCase());
        if (!result) {
            return { success: false, errorType: ERROR_TYPES.NOT_FOUND, error: 'Kod bulunamadı.' };
        }
        return { success: true };
    }

    /**
     * Event yayınlama (loose coupling)
     * @private
     */
    _emitTrialActivated(restaurantId, code, expiresAt) {
        try {
            const brainBus = require('../events/brainBus');
            brainBus.emit('trial_activated', {
                restaurantId,
                code,
                expiresAt,
                type: 'time_based'
            });
        } catch (e) {
            // Event sistemi yoksa sessizce atla
            console.log('ℹ️ [TRIAL] Event sistemi mevcut değil, trial_activated event atlandı.');
        }
    }

    /**
     * WhatsApp sipariş bildirim tercihini restaurant_settings'e kaydet
     * PayTR callback'teki aynı mantık — deneme kodu akışında da çalışır
     * @private
     */
    async _saveWhatsAppPreference(restaurantId, whatsappSelected, whatsappPhone) {
        try {
            const db = require('../config/db');
            const isWa = whatsappSelected ? 1 : 0;
            const waPhone = whatsappPhone || null;

            const [existSettings] = await db.promise().execute(
                'SELECT id FROM restaurant_settings WHERE restaurant_id = ? ORDER BY id ASC LIMIT 1',
                [restaurantId]
            );

            if (existSettings.length > 0) {
                await db.promise().execute(
                    'UPDATE restaurant_settings SET whatsapp_order_notify = ?, whatsapp_phone = ? WHERE id = ? AND restaurant_id = ?',
                    [isWa, waPhone, existSettings[0].id, restaurantId]
                );
            } else {
                await db.promise().execute(
                    'INSERT INTO restaurant_settings (restaurant_id, whatsapp_order_notify, whatsapp_phone) VALUES (?, ?, ?)',
                    [restaurantId, isWa, waPhone]
                );
            }
            console.log(`📱 [TRIAL] WhatsApp sipariş bildirim tercihi kaydedildi (${isWa}): Restoran ${restaurantId}`);
        } catch (err) {
            // WhatsApp kayıt hatası deneme aktivasyonunu engellememeli
            console.error('⚠️ [TRIAL] WhatsApp bildirim ayarı hatası (trial etkilenmez):', err.message);
        }
    }
}

module.exports = new TrialCodeService();
module.exports.ERROR_TYPES = ERROR_TYPES;
