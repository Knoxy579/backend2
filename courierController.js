const db = require("../config/db");
const orderController = require("./orderController");

/**
 * Türkçe uyumlu Title Case dönüşümü.
 * Google Maps geocoding BÜYÜK HARF Türkçe karakterlerde (İ, Ş, Ğ, Ö, Ü, Ç)
 * hatalı sonuç üretebiliyor. Title Case ile doğruluk artıyor.
 * Örnek: "KAYIŞDAĞI" → "Kayışdağı", "ATAŞEHİR" → "Ataşehir"
 */
function toTurkishTitleCase(str) {
  if (!str || str === "Belirtilmedi") return str || "";
  return str
    .toLocaleLowerCase('tr-TR')
    .split(' ')
    .map(word => word.charAt(0).toLocaleUpperCase('tr-TR') + word.slice(1))
    .join(' ');
}

/**
 * Restoran kurye anahtarına (hash) göre aktif siparişleri listeler.
 */
exports.getOrdersByRestaurantKey = async (req, res) => {
  const { restaurantKey } = req.params;

  try {
    // 1. Restoranı anahtar üzerinden doğrula
    const [restaurantRows] = await db.promise().query(
      "SELECT id, name FROM restaurants WHERE courier_panel_key = ?",
      [restaurantKey]
    );

    if (restaurantRows.length === 0) {
      return res.status(404).json({ error: "Geçersiz kurye anahtarı." });
    }

    const restaurantId = restaurantRows[0].id;

    // 2. Aktif siparişleri en güvenli JOIN yapısıyla getir
    // 2. Aktif ve son 24 saatlik teslim edilmiş siparişleri en güvenli JOIN yapısıyla getir
    const query = `
      SELECT
        o.id as order_primary_id,
        o.*,
        COALESCE(o.address_title, a.title) AS addr_title,
        COALESCE(o.address_city, a.city) AS city,
        COALESCE(o.address_district, a.district) AS district,
        COALESCE(o.address_neighborhood, a.neighborhood) AS neighborhood,
        COALESCE(o.address_street, a.street) AS street,
        COALESCE(o.address_detail, a.address_detail) AS detail,
        u.full_name,
        u.phone
      FROM
        orders o
      LEFT JOIN
        addresses a ON o.address_id = a.id
      LEFT JOIN
        users u ON o.user_id = u.id
      WHERE
        o.restaurant_id = ?
        AND o.order_status IN ('pending', 'preparing', 'on_the_way', 'delivered')
        AND o.order_time >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
      ORDER BY o.id DESC
    `;

    const [orders] = await db.promise().query(query, [restaurantId]);

    // 3. Her siparişin kalemlerini detaylı getir
    const orderIds = orders.map(o => o.order_primary_id);
    let items = [];

    if (orderIds.length > 0) {
      const [itemRows] = await db.promise().query(
        `SELECT
          oi.*,
          COALESCE(p.name, m.name) AS item_name
        FROM order_items oi
        LEFT JOIN products p ON oi.product_id = p.id
        LEFT JOIN menus m ON oi.menu_id = m.id
        WHERE oi.order_id IN (?)`,
        [orderIds]
      );
      items = itemRows;
    }

    // 4. Sipariş verilerini işle ve adres bileşenlerini birleştir
    const ordersProcessed = orders.map(order => {
      // --- NAVİGASYON ADRESİ: Google Maps için optimize edilmiş format ---
      
      // City: "İSTANBUL (AVRUPA)" → "İstanbul"
      let navCity = toTurkishTitleCase((order.city || "").replace(/\s*\(.*?\)\s*/g, "").trim());
      
      // District: "ATAŞEHİR" → "Ataşehir"
      let navDistrict = toTurkishTitleCase((order.district || "").trim());
      
      // Neighborhood: "KAYIŞDAĞI" → "Kayışdağı Mahallesi"
      let navNeighborhood = toTurkishTitleCase((order.neighborhood || "").trim());
      if (navNeighborhood && navNeighborhood !== "Belirtilmedi") {
        // Zaten "Mah" içermiyorsa ekle
        if (!navNeighborhood.toLowerCase().includes("mah")) {
          navNeighborhood += " Mahallesi";
        }
      }
      
      // Street: Kullanıcı girişlerini temizle — "493.sokak  no:35 No: daire:5" → "493. Sokak"
      let rawStreet = (order.street || "").trim();
      // Sokak adından daire/no bilgilerini çıkar (bunlar adres detayında kalmalı)
      let navStreet = toTurkishTitleCase(rawStreet
        .replace(/\s*no:\s*\S+/gi, "")     // "no:35" gibi kısımları kaldır
        .replace(/\s*No:\s*\S+/g, "")       // "No: daire:5" gibi kısımları kaldır
        .replace(/\s*daire\s*:\s*\S+/gi, "")// "daire:5" kısımlarını kaldır
        .replace(/\s*kat\s*:\s*\S+/gi, "")  // "kat:3" kısımlarını kaldır
        .replace(/\s+/g, " ")              // Çoklu boşlukları temizle
        .trim());
      
      // Bina numarasını ayıkla (orijinal street'ten)
      let building_no = "";
      const noMatch = rawStreet.match(/(?:^|\s)No:\s*(\d+)/i);
      if (noMatch) {
        building_no = noMatch[1];
      } else {
        // "no:35" formatını da yakala
        const altNoMatch = rawStreet.match(/(?:^|\s)no:\s*(\d+)/i);
        if (altNoMatch) building_no = altNoMatch[1];
      }
      
      // Google Maps için navigasyon adresi oluştur (virgül ayraçlı, daha doğru sonuç verir)
      const navigationParts = [
        navNeighborhood,
        navStreet && navStreet !== "Belirtilmedi" ? navStreet + (building_no ? " No:" + building_no : "") : "",
        navDistrict,
        navCity
      ].filter(part => part && part !== "Belirtilmedi" && part.trim() !== "");
      
      const navigationAddress = navigationParts.join(", ");
      
      // Kullanıcının girdiği ek detaylar (Daire, Kat, Tarif vb.)
      const extraDetail = order.detail || order.address_detail || order.address_description || "";

      return {
        ...order,
        id: order.order_primary_id,
        customer_name: order.full_name || order.customer_full_name || order.customer_name || "Misafir",
        customer_phone: order.phone || order.customer_phone || "",
        street: navStreet,
        building_no: building_no,
        navigation_address: navigationAddress,
        address_detail: navigationAddress,
        extra_detail: extraDetail,
        items: items.filter(item => item.order_id === order.order_primary_id)
      };
    });

    return res.status(200).json({
      status: "success",
      restaurant_name: restaurantRows[0].name,
      data: ordersProcessed
    });

  } catch (error) {
    console.error("❌ [KURYE CONTROLLER HATASI]:", error);
    return res.status(500).json({
      error: "Siparişler listelenirken bir hata oluştu.",
      details: error.message
    });
  }
};

/**
 * Kurye paneli üzerinden sipariş durumunu günceller.
 */
exports.updateCourierOrderStatus = async (req, res) => {
  const { orderId, restaurantKey } = req.params;
  const { status, note } = req.body;

  try {
    // 1. Restoran doğrulaması
    const [restaurantRows] = await db.promise().query(
      "SELECT id FROM restaurants WHERE courier_panel_key = ?",
      [restaurantKey]
    );

    if (restaurantRows.length === 0) {
      return res.status(404).json({ error: "Geçersiz kurye anahtarı." });
    }

    const restaurantId = restaurantRows[0].id;

    // 2. Siparişin bu restorana ait olduğunu doğrula
    const [orderRows] = await db.promise().query(
      "SELECT id FROM orders WHERE id = ? AND restaurant_id = ?",
      [orderId, restaurantId]
    );

    if (orderRows.length === 0) {
      console.error(`❌ [404] Sipariş bulunamadı: ID=${orderId}, Restoran=${restaurantId}`);
      return res.status(404).json({ error: "Sipariş veritabanında bulunamadı." });
    }

    // 3. Merkezi orderController.updateOrderStatus fonksiyonunu çağır
    const fakeReq = {
      params: { id: orderId },
      body: {
        order_status: status,
        note: note || "Kurye paneli üzerinden güncellendi."
      },
      restaurant_id: restaurantId,
      user: null
    };

    console.log(`📡 [KURYE MANTIK]: Sipariş ${orderId} durumu '${status}' yapılıyor...`);

    // Doğrudan controller fonksiyonunu çağır
    return await orderController.updateOrderStatus(fakeReq, res);

  } catch (error) {
    console.error("❌ [KURYE DURUM GÜNCELLEME HATASI]:", error);
    return res.status(500).json({ error: "İşlem sırasında sunucu hatası oluştu." });
  }
};
