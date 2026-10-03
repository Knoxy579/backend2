const db = require("../config/db");
const moment = require("moment");

const getAllCategories = (req, res) => {
  const restaurant_id = req.restaurant_id;
  const { include_inactive } = req.query;

  // Admin paneli include_inactive=true gönderirse tüm kategorileri getir
  const activeFilter = include_inactive === 'true' ? '' : 'AND is_active = TRUE';

  const query = `
    SELECT
      id,
      restaurant_id,
      name,
      description,
      is_active,
      created_at,
      updated_at
    FROM
      categories
    WHERE
      restaurant_id = ? ${activeFilter}
  `;

  db.query(query, [restaurant_id], (err, results) => {
    if (err) {
      console.error("Kategori sorgulama hatası:", err);
      return res.status(500).json({ error: "Veritabanı hatası: " + err.message });
    }

    res.status(200).json({
      status: "success",
      data: results,
    });
  });
};

// Tek bir kategoriyi getir
const getCategoryById = (req, res) => {
  const restaurant_id = req.restaurant_id;
  const categoryId = req.params.id;

  const query = `
    SELECT
      id,
      restaurant_id,
      name,
      description,
      is_active,
      created_at,
      updated_at
    FROM
      categories
    WHERE
      id = ? AND restaurant_id = ?
  `;

  db.query(query, [categoryId, restaurant_id], (err, results) => {
    if (err) {
      console.error("Kategori sorgulama hatası:", err);
      return res.status(500).json({ error: "Veritabanı hatası: " + err.message });
    }

    if (results.length === 0) {
      return res.status(404).json({ error: "Kategori bulunamadı" });
    }

    res.status(200).json({
      status: "success",
      data: results[0],
    });
  });
};

// Yeni kategori ekle
const createCategory = (req, res) => {
  const restaurant_id = req.restaurant_id;
  const { name, description, is_active = true } = req.body;

  if (!name) {
    return res.status(400).json({ error: "Kategori adı zorunludur." });
  }

  const query = `
    INSERT INTO categories (restaurant_id, name, description, is_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `;

  const values = [
    restaurant_id,
    name,
    description || null,
    is_active,
    moment().toDate(),
    moment().toDate(),
  ];

  db.query(query, values, (err, result) => {
    if (err) {
      console.error("Kategori ekleme hatası:", err);
      return res.status(500).json({ error: "Kategori eklenemedi." });
    }

    res.status(201).json({
      status: "success",
      message: "Kategori başarıyla eklendi.",
      category_id: result.insertId,
    });
  });
};

// Kategoriyi güncelle
const updateCategory = (req, res) => {
  const restaurant_id = req.restaurant_id;
  const categoryId = req.params.id;
  const { name, description, is_active } = req.body;

  db.query("SELECT * FROM categories WHERE id = ? AND restaurant_id = ?", [categoryId, restaurant_id], (err, results) => {
    if (err) {
      console.error("Kategori sorgulama hatası:", err);
      return res.status(500).json({ error: "Veritabanı hatası: " + err.message });
    }

    if (results.length === 0) {
      return res.status(404).json({ error: "Kategori bulunamadı" });
    }

    const query = `
      UPDATE categories
      SET
        name = ?,
        description = ?,
        is_active = ?,
        updated_at = ?
      WHERE
        id = ? AND restaurant_id = ?
    `;

    const values = [
      name || results[0].name,
      description !== undefined ? description : results[0].description,
      is_active !== undefined ? is_active : results[0].is_active,
      moment().toDate(),
      categoryId,
      restaurant_id,
    ];

    db.query(query, values, (err, result) => {
      if (err) {
        console.error("Kategori güncelleme hatası:", err);
        return res.status(500).json({ error: "Kategori güncellenemedi." });
      }

      res.status(200).json({
        status: "success",
        message: "Kategori başarıyla güncellendi.",
      });
    });
  });
};

// Kategoriyi sil
const deleteCategory = (req, res) => {
  const restaurant_id = req.restaurant_id;
  const categoryId = req.params.id;

  // 1. Kategoriye bağlı ürün var mı kontrol et
  db.query("SELECT COUNT(*) as count FROM product_categories WHERE category_id = ? AND restaurant_id = ?", [categoryId, restaurant_id], (err, productResults) => {
    if (err) {
      console.error("Ürün sorgulama hatası:", err);
      return res.status(500).json({ error: "Veritabanı hatası: " + err.message });
    }

    if (productResults[0].count > 0) {
      return res.status(400).json({ error: "Bu kategoriye bağlı ürünler var, önce ürünleri silin veya başka kategoriye taşıyın." });
    }

    // 2. Kategoriye bağlı menü var mı kontrol et
    db.query("SELECT COUNT(*) as count FROM menu_categories WHERE category_id = ? AND restaurant_id = ?", [categoryId, restaurant_id], (err, menuResults) => {
      if (err) {
        console.error("Menü sorgulama hatası:", err);
        return res.status(500).json({ error: "Veritabanı hatası: " + err.message });
      }

      if (menuResults[0].count > 0) {
        return res.status(400).json({ error: "Bu kategoriye bağlı menüler var, önce menüleri silin veya kategorisini değiştirin." });
      }

      // 3. Kategoriyi kontrol et ve sil
      db.query("SELECT * FROM categories WHERE id = ? AND restaurant_id = ?", [categoryId, restaurant_id], async (err, results) => {
        if (err) {
          console.error("Kategori sorgulama hatası:", err);
          return res.status(500).json({ error: "Veritabanı hatası: " + err.message });
        }

        if (results.length === 0) {
          return res.status(404).json({ error: "Kategori bulunamadı" });
        }

        try {
          const connection = db.promise();
          
          // İlişkili tabloları temizle (her ihtimale karşı)
          await connection.query("DELETE FROM product_categories WHERE category_id = ? AND restaurant_id = ?", [categoryId, restaurant_id]);
          await connection.query("DELETE FROM menu_categories WHERE category_id = ? AND restaurant_id = ?", [categoryId, restaurant_id]);
          
          // Kategoriyi sil
          await connection.query("DELETE FROM categories WHERE id = ? AND restaurant_id = ?", [categoryId, restaurant_id]);

          res.status(200).json({
            status: "success",
            message: "Kategori tamamen silindi.",
          });
        } catch (deleteErr) {
          console.error("Kategori silme hatası:", deleteErr);
          return res.status(500).json({ error: "Kategori silinemedi: " + deleteErr.message });
        }
      });
    });
  });
};


// Bir kategoriye ürünleri toplu olarak bağla (çoktan çoğa ilişki)
const assignProductsToCategory = (req, res) => {
  const restaurant_id = req.restaurant_id;
  const categoryId = req.params.id;
  const { productIds } = req.body;

  // İstek doğrulama
  if (!Array.isArray(productIds)) {
    return res
      .status(400)
      .json({ error: "productIds alanı dizi formatında olmalıdır." });
  }

  const uniqueProductIds = [...new Set(productIds.map((id) => Number(id)))]
    .filter((id) => !Number.isNaN(id) && id > 0);

  // Kategori kontrolü
  db.query(
    "SELECT id FROM categories WHERE id = ? AND restaurant_id = ?",
    [categoryId, restaurant_id],
    (err, categoryResult) => {
      if (err) {
        console.error("Kategori sorgulama hatası:", err);
        return res.status(500).json({ error: "Veritabanı hatası: " + err.message });
      }

      if (categoryResult.length === 0) {
        return res
          .status(404)
          .json({ error: "Kategori bulunamadı veya pasif." });
      }

      // Liste boşsa kategorideki ürünleri temizle
      if (uniqueProductIds.length === 0) {
        const clearQuery = `
          DELETE FROM product_categories
          WHERE category_id = ? AND restaurant_id = ?
        `;

        db.query(clearQuery, [categoryId, restaurant_id], (err, result) => {
          if (err) {
            console.error("Kategori temizleme hatası:", err);
            return res
              .status(500)
              .json({ error: "Kategori ilişkileri temizlenemedi." });
          }

          return res.status(200).json({
            status: "success",
            message: "Kategoriye bağlı ürünler temizlendi.",
            updated_count: result.affectedRows,
          });
        });
        return;
      }

      // Ürünlerin varlık kontrolü
      const placeholders = uniqueProductIds.map(() => "?").join(",");
      const findProductsQuery = `SELECT id FROM products WHERE id IN (${placeholders}) AND restaurant_id = ?`;

      db.query(findProductsQuery, [...uniqueProductIds, restaurant_id], (err, productResult) => {
        if (err) {
          console.error("Ürün sorgulama hatası:", err);
          return res.status(500).json({ error: "Veritabanı hatası: " + err.message });
        }

        const foundIds = productResult.map((row) => row.id);
        const missingIds = uniqueProductIds.filter(
          (id) => !foundIds.includes(id)
        );

        if (missingIds.length > 0) {
          return res.status(400).json({
            error: "Bazı ürünler bulunamadı.",
            missing_products: missingIds,
          });
        }

        // Önce bu kategoriye ait mevcut ilişkileri sil
        const deleteQuery = `
          DELETE FROM product_categories
          WHERE category_id = ? AND restaurant_id = ?
        `;

        db.query(deleteQuery, [categoryId, restaurant_id], (err) => {
          if (err) {
            console.error("Mevcut ilişkiler silinirken hata:", err);
            return res.status(500).json({ error: "Veritabanı hatası: " + err.message });
          }

          // Yeni ilişkileri ekle (çoktan çoğa)
          const categoryValues = uniqueProductIds.map((productId) => [
            productId,
            parseInt(categoryId),
            restaurant_id,
          ]);

          const insertQuery = `
            INSERT INTO product_categories (product_id, category_id, restaurant_id)
            VALUES ?
          `;

          db.query(insertQuery, [categoryValues], (err, insertResult) => {
            if (err) {
              console.error("Ürün-kategori ilişkileri eklenirken hata:", err);
              return res
                .status(500)
                .json({ error: "Ürünler kategoriye atanamadı." });
            }

            // product_categories tablosu artık tek kaynak (source of truth)
            // products.category_id legacy alanı NOT NULL olduğu için güncellenmez
            res.status(200).json({
              status: "success",
              message: "Ürünler kategoriye başarıyla atandı.",
              updated_count: insertResult.affectedRows,
            });
          });
        });
      });
    }
  );
};

// Bir kategoriye menüleri toplu olarak bağla (çoktan çoğa ilişki)
const assignMenusToCategory = (req, res) => {
  const restaurant_id = req.restaurant_id;
  const categoryId = req.params.id;
  const { menuIds } = req.body;

  // İstek doğrulama
  if (!Array.isArray(menuIds)) {
    return res
      .status(400)
      .json({ error: "menuIds alanı dizi formatında olmalıdır." });
  }

  const uniqueMenuIds = [...new Set(menuIds.map((id) => Number(id)))]
    .filter((id) => !Number.isNaN(id) && id > 0);

  // Kategori kontrolü
  db.query(
    "SELECT id FROM categories WHERE id = ? AND restaurant_id = ?",
    [categoryId, restaurant_id],
    (err, categoryResult) => {
      if (err) {
        console.error("Kategori sorgulama hatası:", err);
        return res.status(500).json({ error: "Veritabanı hatası: " + err.message });
      }

      if (categoryResult.length === 0) {
        return res
          .status(404)
          .json({ error: "Kategori bulunamadı veya pasif." });
      }

      // Liste boşsa kategorideki menüleri temizle
      if (uniqueMenuIds.length === 0) {
        const clearQuery = `
          DELETE FROM menu_categories
          WHERE category_id = ?
        `;

        db.query(clearQuery, [categoryId], (err, result) => {
          if (err) {
            console.error("Kategori temizleme hatası:", err);
            return res
              .status(500)
              .json({ error: "Kategori ilişkileri temizlenemedi." });
          }

          return res.status(200).json({
            status: "success",
            message: "Kategoriye bağlı menüler temizlendi.",
            updated_count: result.affectedRows,
          });
        });
        return;
      }

      // Menülerin varlık kontrolü
      const placeholders = uniqueMenuIds.map(() => "?").join(",");
      const findMenusQuery = `SELECT id FROM menus WHERE id IN (${placeholders}) AND restaurant_id = ?`;

      db.query(findMenusQuery, [...uniqueMenuIds, restaurant_id], (err, menuResult) => {
        if (err) {
          console.error("Menü sorgulama hatası:", err);
          return res.status(500).json({ error: "Veritabanı hatası: " + err.message });
        }

        const foundIds = menuResult.map((row) => row.id);
        const missingIds = uniqueMenuIds.filter(
          (id) => !foundIds.includes(id)
        );

        if (missingIds.length > 0) {
          return res.status(400).json({
            error: "Bazı menüler bulunamadı.",
            missing_menus: missingIds,
          });
        }

        // Önce bu kategoriye ait mevcut ilişkileri sil
        const deleteQuery = `
          DELETE FROM menu_categories
          WHERE category_id = ? AND restaurant_id = ?
        `;

        db.query(deleteQuery, [categoryId, restaurant_id], (err) => {
          if (err) {
            console.error("Mevcut ilişkiler silinirken hata:", err);
            return res.status(500).json({ error: "Veritabanı hatası: " + err.message });
          }

          // Yeni ilişkileri ekle (çoktan çoğa)
          const categoryValues = uniqueMenuIds.map((menuId) => [
            menuId,
            parseInt(categoryId),
            restaurant_id, // restaurant_id eklendi
          ]);

          const insertQuery = `
            INSERT INTO menu_categories (menu_id, category_id, restaurant_id)
            VALUES ?
          `;

          db.query(insertQuery, [categoryValues], (err, insertResult) => {
            if (err) {
              console.error("Menü-kategori ilişkileri eklenirken hata:", err);
              return res
                .status(500)
                .json({ error: "Menüler kategoriye atanamadı." });
            }

            res.status(200).json({
              status: "success",
              message: "Menüler kategoriye başarıyla atandı.",
              updated_count: insertResult.affectedRows,
            });
          });
        });
      });
    }
  );
};

// Bir kategorinin ürünlerini getir
const getCategoryProducts = (req, res) => {
  const restaurant_id = req.restaurant_id;
  const categoryId = req.params.id;

  // product_categories tablosundan çek (tek kaynak)
  const query = `
    SELECT DISTINCT p.id, p.name
    FROM products p
    INNER JOIN product_categories pc ON p.id = pc.product_id
    WHERE pc.category_id = ? AND pc.restaurant_id = ?
  `;

  db.query(query, [categoryId, restaurant_id], (err, results) => {
    if (err) {
      console.error("Kategori ürünleri sorgulama hatası:", err);
      return res.status(500).json({ error: "Veritabanı hatası: " + err.message });
    }

    // product_categories'de bu kategori için kayıt yoksa,
    // eski products.category_id'den otomatik migration yap
    if (results.length === 0) {
      const legacyQuery = `
        SELECT id, name FROM products
        WHERE category_id = ? AND restaurant_id = ?
      `;
      db.query(legacyQuery, [categoryId, restaurant_id], (err2, legacyProducts) => {
        if (err2 || !legacyProducts || legacyProducts.length === 0) {
          return res.status(200).json({ status: "success", data: [] });
        }

        // Eski verileri product_categories'e taşı (otomatik migration)
        const migrationValues = legacyProducts.map((p) => [p.id, parseInt(categoryId), restaurant_id]);
        const migrateQuery = `
          INSERT IGNORE INTO product_categories (product_id, category_id, restaurant_id) VALUES ?
        `;
        db.query(migrateQuery, [migrationValues], (err3) => {
          if (err3) console.error("Otomatik migration hatası:", err3);
          
          return res.status(200).json({
            status: "success",
            data: legacyProducts,
          });
        });
      });
      return;
    }

    res.status(200).json({
      status: "success",
      data: results,
    });
  });
};

// Bir kategorinin menülerini getir
const getCategoryMenus = (req, res) => {
  const restaurant_id = req.restaurant_id;
  const categoryId = req.params.id;

  const query = `
    SELECT m.id, m.name
    FROM menus m
    INNER JOIN menu_categories mc ON m.id = mc.menu_id
    WHERE mc.category_id = ? AND m.restaurant_id = ? AND m.is_active = TRUE
  `;

  db.query(query, [categoryId, restaurant_id], (err, results) => {
    if (err) {
      console.error("Kategori menüleri sorgulama hatası:", err);
      return res.status(500).json({ error: "Veritabanı hatası: " + err.message });
    }

    res.status(200).json({
      status: "success",
      data: results,
    });
  });
};

module.exports = {
  getAllCategories,
  getCategoryById,
  createCategory,
  updateCategory,
  deleteCategory,
  assignProductsToCategory,
  assignMenusToCategory,
  getCategoryProducts,
  getCategoryMenus,
};