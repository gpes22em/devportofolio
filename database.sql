// Vercel Serverless Function (Node.js)
// Endpoint: POST /api/order

const { Pool } = require('pg');

// PostgreSQL Pool (Neon / Vercel Postgres)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false, // Required for Neon & many managed Postgres services
  },
});

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
    const body = req.body || {};
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
    const recaptchaVerify = await fetch(
      'https://www.google.com/recaptcha/api/siteverify',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `secret=${encodeURIComponent(recaptchaSecret)}&response=${encodeURIComponent(recaptchaResponse)}&remoteip=${encodeURIComponent(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '')}`,
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

    const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';

    // --- 3. Simpan ke PostgreSQL ---
    const insertResult = await pool.query(
      `INSERT INTO orders (name, whatsapp, category, budget, description, ip_address, status, wa_notified, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'new', 0, NOW()) RETURNING id`,
      [name, whatsapp, category, budget, description, ip]
    );
    const orderId = insertResult.rows[0].id;

    // --- 4. Kirim Notifikasi Telegram ---
    const tgToken = process.env.TELEGRAM_BOT_TOKEN;
    const tgChatId = process.env.TELEGRAM_CHAT_ID;
    let tgSuccess = false;

    if (tgToken && tgChatId) {
      const message = `🔔 PESANAN BARU\n\n📌 ID: #${orderId}\n👤 Nama: ${name}\n📱 WhatsApp: ${whatsapp}\n📂 Kategori: ${category}\n💰 Budget: ${budget}\n\n📝 Deskripsi:\n${description}\n\n🌐 IP: ${ip}\nMohon segera ditindaklanjuti.`;

      try {
        const tgRes = await fetch(
          `https://api.telegram.org/bot${tgToken}/sendMessage`,
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
        tgSuccess = false;
      }
    }

    // --- Update notifikasi status ---
    if (tgSuccess) {
      await pool.query('UPDATE orders SET wa_notified = 1 WHERE id = $1', [orderId]);
    }

    // --- 5. Email Backup (Optional) ---
    const adminEmail = process.env.ADMIN_EMAIL;
    if (adminEmail) {
      const emailBody = `ID Pesanan: #${orderId}\nNama: ${name}\nWhatsApp: ${whatsapp}\nKategori: ${category}\nBudget: ${budget}\n\nDeskripsi:\n${description}\n\nIP: ${ip}\nWaktu: ${new Date().toISOString()}\nNotif Telegram: ${tgSuccess ? 'Berhasil' : 'Gagal'}`;
      try {
        await fetch('https://api.sendgrid.com/v3/mail/send', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${process.env.SENDGRID_API_KEY || ''}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            personalizations: [{ to: [{ email: adminEmail }] }],
            from: { email: 'noreply@devportfolio.com' },
            subject: `[PESANAN JASA #${orderId}] ${category} - ${name}`,
            content: [{ type: 'text/plain', value: emailBody }],
          }),
        });
      } catch (e) {
        // email optional, ignore error
      }
    }

    // --- Response ---
    if (tgSuccess) {
      return res.status(200).json({
        status: 'success',
        message: 'Pengajuan berhasil! Notifikasi Telegram terkirim ke HP Anda.',
      });
    }
    return res.status(200).json({
      status: 'success',
      message: 'Pengajuan berhasil disimpan. Notifikasi instan sementara gagal, tapi data sudah tercatat di sistem.',
    });
  } catch (err) {
    console.error('Order API Error:', err);
    return res.status(500).json({ status: 'error', message: 'Server error: ' + err.message });
  }
};
