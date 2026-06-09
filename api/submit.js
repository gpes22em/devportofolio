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

    // TETAP PAKAI: www.google.com murni tanpa tambahan apa pun
    const options = {
      hostname: 'www.google.com', 
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

    const ipAddress = req.headers['x-forwarded-for'] || 'unknown';

    // 1. Simpan ke database PostgreSQL 
    const insertResult = await pool.query(
      `INSERT INTO orders (name, whatsapp, category, budget, description, ip_address, status, wa_notified, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'new', 0, NOW()) RETURNING id`,
      [name.trim(), whatsapp.trim(), category.trim(), budget.trim(), description.trim(), ipAddress]
    );

    // KOREKSI UTAMA: Ditambahkan [0] agar membaca ID dengan benar dari array
    const orderId = insertResult.rows && insertResult.rows.length > 0 ? insertResult.rows[0].id : 'N/A';

    // 2. Kirim Notifikasi langsung ke Grup Telegram Anda (-1003949170710)
    const tgToken = "8910424366:AAHFAwYWLeMCLfB8fnmg1wtn8LFuD4i0uM0";
    const tgChatId = "-1003949170710";
    let tgSuccess = false;

    if (tgToken && tgChatId) {
      const message = `🔔 <b>PESANAN BARU</b>\n\n📌 <b>ID:</b> #${orderId}\n👤 <b>Nama:</b> ${name}\n📱 <b>WhatsApp:</b> ${whatsapp}\n📂 <b>Kategori:</b> ${category}\n💰 <b>Budget:</b> ${budget}\n\n📝 <b>Deskripsi:</b>\n${description}\n\n🌐 <b>IP:</b> ${ipAddress}\nMohon segera ditindaklanjuti.`;

      try {
        const tgRes = await fetch(
          `https://telegram.org{tgToken}/sendMessage`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: tgChatId,
              text: message,
              parse_mode: 'HTML',
            }),
          }
        );
        const tgData = await tgRes.json();
        tgSuccess = tgData.ok === true;
      } catch (e) {
        console.error('Gagal mengirim ke Telegram:', e);
        tgSuccess = false;
      }
    }

    // 3. Update status database jika Telegram sukses terkirim
    if (tgSuccess) {
      await pool.query('UPDATE orders SET wa_notified = 1 WHERE id = $1', [orderId]);
    }

    return res.status(200).json({ 
      status: 'success', 
      message: tgSuccess 
        ? 'Pengajuan berhasil! Notifikasi Telegram telah terkirim ke HP Anda.' 
        : 'Pengajuan berhasil disimpan ke Database, namun notifikasi Telegram gagal.' 
    });

  } catch (err) {
    console.error('Server error:', err);
    return res.status(500).json({ status: 'error', message: 'Server error: ' + err.message });
  }
};
