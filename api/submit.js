const https = require('https');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function parseRequestBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch (e) { resolve({}); }
    });
  });
}

function verifyGoogleRecaptcha(secret, response, remoteIp) {
  return new Promise((resolve, reject) => {
    const payload = new URLSearchParams({
      secret: secret,
      response: response,
      remoteip: remoteIp
    }).toString();

    const options = {
      hostname: '://google.com', 
      path: '/recaptcha/api/siteverify',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(payload),
        'User-Agent': 'Node-HTTPS-Client'
      },
      timeout: 5000
    };

    const request = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { resolve({ success: false }); }
      });
    });

    request.on('error', (error) => { reject(error); });
    request.write(payload);
    request.end();
  });
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ status: 'error', message: 'Method Not Allowed' });

  try {
    const body = await parseRequestBody(req);
    const { name, whatsapp, category, budget, description } = body;
    const recaptchaResponse = body['g-recaptcha-response'] || '';

    if (!recaptchaResponse) return res.status(400).json({ status: 'error', message: 'reCAPTCHA diperlukan.' });

    const recaptchaData = await verifyGoogleRecaptcha(process.env.RECAPTCHA_SECRET, recaptchaResponse, req.headers['x-forwarded-for'] || '');

    if (!recaptchaData || recaptchaData.success !== true) {
      return res.status(400).json({ status: 'error', message: 'Verifikasi reCAPTCHA gagal.' });
    }

    if (!name || !whatsapp || !category || !budget || !description) {
      return res.status(400).json({ status: 'error', message: 'Semua field wajib diisi.' });
    }

    // 1. Simpan ke database PostgreSQL 
    await pool.query(
      `INSERT INTO orders (name, whatsapp, category, budget, description, ip_address, status, wa_notified, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'new', 0, NOW())`,
      [name.trim(), whatsapp.trim(), category.trim(), budget.trim(), description.trim(), req.headers['x-forwarded-for'] || 'unknown']
    );

    // 2. Kirim teks biasa ke Telegram agar tidak diblokir/ditolak sistem Telegram
    const rawMessage = `🔔 PESANAN BARU\n\n👤 Nama: ${name}\n📱 WhatsApp: ${whatsapp}\n📂 Kategori: ${category}\n💰 Budget: ${budget}\n\n📝 Deskripsi:\n${description}`;

    const tgToken = "8910424366:AAHFAwYWLeMCLfB8fnmg1wtn8LFuD4i0uM0";
    const tgChatId = "-1003949170710";

    const tgRes = await fetch(`https://telegram.org{tgToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: tgChatId,
        text: rawMessage
      })
    });

    const tgData = await tgRes.json();

    if (tgData.ok === true) {
      return res.status(200).json({ status: 'success', message: 'Pengajuan berhasil masuk ke Database dan Telegram Anda!' });
    } else {
      // Jika Telegram menolak, dia akan memunculkan alasan konkretnya di layar Anda
      return res.status(400).json({ status: 'error', message: 'Database Sukses, tapi Telegram Menolak: ' + tgData.description });
    }

  } catch (err) {
    return res.status(500).json({ status: 'error', message: 'Server error: ' + err.message });
  }
};
