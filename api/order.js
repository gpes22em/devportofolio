const { Pool } = require('pg');

// PostgreSQL Pool (Neon / Vercel Postgres)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});

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

    const verifyData = new URLSearchParams();
    verifyData.append('secret', recaptchaSecret);
    verifyData.append('response', recaptchaResponse);
    verifyData.append('remoteip', remoteIp);

    // Kirim ke URL Valid Google API
    const recaptchaVerify = await fetch(
      'https://google.com',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: verifyData.toString(),
      }
    );
    const recaptchaData = await recaptchaVerify.json();

    if (!recaptchaData || recaptchaData.success !== true) {
      return res.status(400).json({ status: 'error', message: 'Verifikasi reCAPTCHA gagal. Silakan coba lagi.' });
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
      throw new Error('Gagal menyimpan data atau tabel orders tidak merespon.');
    }

    // --- KODE TELEGRAM DAN SENDGRID DIMATIKAN SEMENTARA AGAR TIDAK CRASH ---
    
    return res.status(200).json({
      status: 'success',
      message: 'Pengajuan berhasil disimpan langsung ke database PostgreSQL Anda!',
    });

  } catch (err) {
    console.error('Order API Error:', err);
    return res.status(500).json({ status: 'error', message: 'Server error: ' + err.message });
  }
};
