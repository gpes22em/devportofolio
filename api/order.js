const https = require('https');
const { Pool } = require('pg');

// PostgreSQL Pool (Neon / Vercel Postgres)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});

// Helper untuk memastikan body JSON terbaca sempurna di lingkungan Vercel
async function parseRequestBody(req) {
  if (req.body && typeof req.body === 'object') {
    return req.body;
  }
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); } 
      catch (e) { resolve({}); }
    });
  });
}

// Helper Verifikasi reCAPTCHA menggunakan modul HTTPS murni (Bukan fetch)
function verifyGoogleRecaptcha(secret, response, remoteIp) {
  return new Promise((resolve, reject) => {
    const payload = new URLSearchParams({
      secret: secret,
      response: response,
      remoteip: remoteIp
    }).toString();

    // PERBAIKAN MUTLAK: Hostname murni tanpa karakter "://" atau "https://"
    const options = {
      hostname: '://google.com', 
      path: '/recaptcha/api/siteverify',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(payload),
        'User-Agent': 'Node-HTTPS-Client'
      },
      timeout: 5000 // Batas waktu respons ke Google maksimal 5 detik
    };

    const request = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed);
        } catch (e) {
          console.error("Google returned non-JSON data:", data);
          resolve({ success: false, error: 'invalid-google-response' });
        }
      });
    });

    request.on('error', (error) => { reject(error); });
    request.on('timeout', () => { request.destroy(); reject(new Error('Google API Timeout')); });
    
    request.write(payload);
    request.end();
  });
}

module.exports = async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ status: 'error', message: 'Method Not Allowed' });
  }

  try {
    const body = await parseRequestBody(req);
    
    const name = (body.name || '').trim();
    const whatsapp = (body.whatsapp || '').trim();
    const category = (body.category || '').trim();
    const budget = (body.budget || '').trim();
    const description = (body.description || '').trim();
    const recaptchaResponse = (body['g-recaptcha-response'] || '').trim();

    // --- 1. Validasi reCAPTCHA ---
    if (!recaptchaResponse) {
      return res.status(400).json({ status: 'error', message: 'Verifikasi reCAPTCHA diperlukan.' });
    }

    const recaptchaSecret = process.env.RECAPTCHA_SECRET;
    const remoteIp = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '';

    // Jalankan verifikasi reCAPTCHA menggunakan HTTPS client bawaan
    const recaptchaData = await verifyGoogleRecaptcha(recaptchaSecret, recaptchaResponse, remoteIp);

    if (!recaptchaData || recaptchaData.success !== true) {
      return res.status(400).json({ 
        status: 'error', 
        message: 'Verifikasi reCAPTCHA gagal di sistem keamanan. Silakan coba lagi.' 
      });
    }

    // --- 2. Validasi Field ---
    if (!name || !whatsapp || !category || !budget || !description) {
      return res.status(400).json({ status: 'error', message: 'Semua field wajib diisi.' });
    }

    const ip = remoteIp || 'unknown';

    // --- 3. Simpan ke PostgreSQL ---
    const insertResult = await pool.query(
      `INSERT INTO orders (name, whatsapp, category, budget, description, ip_address, status, wa_notified, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'new', 0, NOW()) RETURNING id`,
      [name, whatsapp, category, budget, description, ip]
    );

    if (!insertResult.rows || insertResult.rows.length === 0) {
      throw new Error('Gagal menyimpan data ke tabel database.');
    }

    // --- Response Akhir Sukses ---
    return res.status(200).json({
      status: 'success',
      message: 'Pengajuan berhasil disimpan langsung ke PostgreSQL Anda!',
    });

  } catch (err) {
    console.error('Order API Error:', err);
    return res.status(500).json({ status: 'error', message: 'Server error: ' + err.message });
  }
};
