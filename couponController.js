const db = require("../config/db");
const moment = require("moment");

const getAllCoupons = (req, res) => {
  const restaurant_id = req.restaurant_id;
  const query = `
    SELECT
      c.*,
      s.full_name AS created_by_name
    FROM
      coupons c
    LEFT JOIN
      staff s ON c.created_by = s.id
    WHERE
      c.active = 1 AND c.restaurant_id = ?
  `;

  db.query(query, [restaurant_id], (err, results) => {
    if (err) {
      console.error("Kupon sorgulama hatası:", err);
      return res.status(500).json({ error: "Veritabanı hatası" });
    }

    res.status(200).json({
      status: "success",
      data: results,
    });
  });
};

// Tek bir kuponu getir
const getCouponById = (req, res) => {
  const restaurant_id = req.restaurant_id;
  const couponId = req.params.id;
  const query = `
    SELECT
      c.*,
      s.full_name AS created_by_name
    FROM
      coupons c
    LEFT JOIN
      staff s ON c.created_by = s.id
    WHERE
      c.id = ? AND c.active = 1 AND c.restaurant_id = ?
  `;

  db.query(query, [couponId, restaurant_id], (err, results) => {
    if (err) {
      console.error("Kupon sorgulama hatası:", err);
      return res.status(500).json({ error: "Veritabanı hatası" });
    }

    if (results.length === 0) {
      return res.status(404).json({ error: "Kupon bulunamadı" });
    }

    res.status(200).json({
      status: "success",
      data: results[0],
    });
  });
};

const createCoupon = (req, res) => {
  const restaurant_id = req.restaurant_id;
  const {
    code,
    description,
    discount_type,
    discount_amount,
    min_order_amount = 0,
    start_date,
    end_date,
    usage_limit,
    active = true,
  } = req.body;
  const created_by = req.user.id; // Giriş yapan personelin ID'si

  // Zorunlu alanları kontrol et
  if (!code || !discount_type || !discount_amount || !start_date || !end_date) {
    return res.status(400).json({
      error: "Kupon kodu, indirim tipi, indirim miktarı, başlangıç ve bitiş tarihi zorunludur.",
    });
  }

  if (!["percentage", "fixed"].includes(discount_type)) {
    return res.status(400).json({ error: "Geçersiz indirim tipi. 'percentage' veya 'fixed' olmalı." });
  }

  db.query("SELECT * FROM coupons WHERE code = ? AND restaurant_id = ?", [code, restaurant_id], (err, results) => {
    if (err) {
      console.error("Kupon sorgulama hatası:", err);
      return res.status(500).json({ error: "Veritabanı hatası" });
    }

    if (results.length > 0) {
      return res.status(400).json({ error: "Bu kupon kodu zaten kullanılıyor." });
    }

    const query = `
      INSERT INTO coupons (
        code, description, discount_type, discount_amount, min_order_amount,
        start_date, end_date, usage_limit, active, created_by, restaurant_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    const values = [
      code,
      description || null,
      discount_type,
      discount_amount,
      min_order_amount,
      moment(start_date).toDate(),
      moment(end_date).toDate(),
      usage_limit || null,
      active,
      created_by,
      restaurant_id,
      moment().toDate(),
      moment().toDate(),
    ];

    db.query(query, values, (err, result) => {
      if (err) {
        console.error("Kupon ekleme hatası:", err);
        return res.status(500).json({ error: "Kupon eklenemedi." });
      }

      res.status(201).json({
        status: "success",
        message: "Kupon başarıyla eklendi.",
        coupon_id: result.insertId,
      });
    });
  });
};

const updateCoupon = (req, res) => {
  const restaurant_id = req.restaurant_id;
  const couponId = req.params.id;
  const {
    code,
    description,
    discount_type,
    discount_amount,
    min_order_amount,
    start_date,
    end_date,
    usage_limit,
    active,
  } = req.body;

  db.query("SELECT * FROM coupons WHERE id = ? AND restaurant_id = ?", [couponId, restaurant_id], (err, results) => {
    if (err) {
      console.error("Kupon sorgulama hatası:", err);
      return res.status(500).json({ error: "Veritabanı hatası" });
    }

    if (results.length === 0) {
      return res.status(404).json({ error: "Kupon bulunamadı" });
    }

    const existingCoupon = results[0];

    if (code && code !== existingCoupon.code) {
      db.query("SELECT * FROM coupons WHERE code = ? AND id != ? AND restaurant_id = ?", [code, couponId, restaurant_id], (err, codeResults) => {
        if (err) {
          console.error("Kupon kodu sorgulama hatası:", err);
          return res.status(500).json({ error: "Veritabanı hatası" });
        }

        if (codeResults.length > 0) {
          return res.status(400).json({ error: "Bu kupon kodu zaten kullanılıyor." });
        }

        updateCouponDetails();
      });
    } else {
      updateCouponDetails();
    }

    function updateCouponDetails() {
      const query = `
        UPDATE coupons
        SET
          code = ?,
          description = ?,
          discount_type = ?,
          discount_amount = ?,
          min_order_amount = ?,
          start_date = ?,
          end_date = ?,
          usage_limit = ?,
          active = ?,
          updated_at = ?
        WHERE
          id = ? AND restaurant_id = ?
      `;

      const values = [
        code || existingCoupon.code,
        description !== undefined ? description : existingCoupon.description,
        discount_type || existingCoupon.discount_type,
        discount_amount || existingCoupon.discount_amount,
        min_order_amount !== undefined ? min_order_amount : existingCoupon.min_order_amount,
        start_date ? moment(start_date).toDate() : existingCoupon.start_date,
        end_date ? moment(end_date).toDate() : existingCoupon.end_date,
        usage_limit !== undefined ? usage_limit : existingCoupon.usage_limit,
        active !== undefined ? active : existingCoupon.active,
        moment().toDate(),
        couponId,
        restaurant_id,
      ];

      db.query(query, values, (err, result) => {
        if (err) {
          console.error("Kupon güncelleme hatası:", err);
          return res.status(500).json({ error: "Kupon güncellenemedi." });
        }

        res.status(200).json({
          status: "success",
          message: "Kupon başarıyla güncellendi.",
        });
      });
    }
  });
};

const deleteCoupon = (req, res) => {
  const restaurant_id = req.restaurant_id;
  const couponId = req.params.id;

  db.query("SELECT * FROM coupons WHERE id = ? AND restaurant_id = ?", [couponId, restaurant_id], (err, results) => {
    if (err) {
      console.error("Kupon sorgulama hatası:", err);
      return res.status(500).json({ error: "Veritabanı hatası" });
    }

    if (results.length === 0) {
      return res.status(404).json({ error: "Kupon bulunamadı" });
    }

    const query = "UPDATE coupons SET active = 0, updated_at = ? WHERE id = ? AND restaurant_id = ?";
    db.query(query, [moment().toDate(), couponId, restaurant_id], (err, result) => {
      if (err) {
        console.error("Kupon silme hatası:", err);
        return res.status(500).json({ error: "Kupon silinemedi." });
      }

      res.status(200).json({
        status: "success",
        message: "Kupon başarıyla silindi.",
      });
    });
  });
};

// Kullanıcının kendi kuponlarını listele (Mobil uygulama için)
const getUserCoupons = (req, res) => {
  const restaurant_id = req.restaurant_id;
  const userId = req.user.id; // authenticateToken middleware'inden gelir

  console.log(`[GET_USER_COUPONS] İstek Alındı | userId: ${userId}, restaurantId: ${restaurant_id}`);

  const query = `
    SELECT c.*, rc.rules_config, rc.template_key 
    FROM coupons c
    LEFT JOIN restaurant_campaigns rc ON c.campaign_id = rc.id
    WHERE c.restaurant_id = ? 
      AND c.user_id = ? 
      AND c.active = 1 
      AND c.is_used = 0
      AND (c.end_date IS NULL OR c.end_date >= NOW())
      AND (c.campaign_id IS NULL OR rc.status = 'Active')
    ORDER BY c.created_at DESC
    LIMIT 100
  `;

  db.query(query, [restaurant_id, userId], (err, results) => {
    if (err) {
      console.error("Kullanıcı kuponları getirme hatası:", err);
      return res.status(500).json({ error: "Kuponlar alınamadı." });
    }

    console.log(`[GET_USER_COUPONS] userId: ${userId} için ${results.length} kupon bulundu.`);
    res.json({
      status: "success",
      data: results
    });
  });
};

module.exports = {
  getAllCoupons,
  getCouponById,
  createCoupon,
  updateCoupon,
  deleteCoupon,
  getUserCoupons,
};