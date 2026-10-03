const axios = require('axios');

const CF_API = 'https://api.cloudflare.com/client/v4';
const ZONE_ID = process.env.CLOUDFLARE_ZONE_ID;
const API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;

const cfAxios = axios.create({
  baseURL: CF_API,
  headers: {
    'Authorization': `Bearer ${API_TOKEN}`,
    'Content-Type': 'application/json'
  }
});

// Cloudflare'e custom hostname ekle
async function addCustomHostname(domain) {
  try {
    const response = await cfAxios.post(`/zones/${ZONE_ID}/custom_hostnames`, {
      hostname: domain,
      ssl: { method: 'http', type: 'dv', settings: { min_tls_version: '1.2' } }
    });
    console.log(`✅ [Cloudflare] Custom hostname eklendi: ${domain}`);
    return {
      success: true,
      id: response.data.result.id,
      status: response.data.result.status,
      ssl_status: response.data.result.ssl.status
    };
  } catch (error) {
    const errMsg = error.response?.data?.errors?.[0]?.message || error.message;
    console.error(`❌ [Cloudflare] Hostname eklenemedi: ${errMsg}`);
    return { success: false, error: errMsg };
  }
}

// Custom hostname durumunu kontrol et
async function getHostnameStatus(hostnameId) {
  try {
    const response = await cfAxios.get(`/zones/${ZONE_ID}/custom_hostnames/${hostnameId}`);
    const result = response.data.result;
    return {
      success: true,
      status: result.status,
      ssl_status: result.ssl?.status || 'unknown',
      verification_errors: result.verification_errors || []
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// Custom hostname sil
async function deleteCustomHostname(hostnameId) {
  try {
    await cfAxios.delete(`/zones/${ZONE_ID}/custom_hostnames/${hostnameId}`);
    console.log(`🗑️ [Cloudflare] Custom hostname silindi: ${hostnameId}`);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

module.exports = { addCustomHostname, getHostnameStatus, deleteCustomHostname };
