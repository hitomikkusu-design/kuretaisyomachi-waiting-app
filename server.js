const express = require('express');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;

/* =========================================================
   🔹 基本確認ルート
========================================================= */
app.get('/', (req, res) => {
  res.send('Kure Waiting App is running 🚀');
});

app.get('/api/liff_id', (req, res) => {
  res.json({ liffId: process.env.LIFF_ID });
});

/* =========================================================
   🔹 LINE Webhook（検証用 + 本番対応）
========================================================= */
app.post('/webhook', (req, res) => {
  console.log('[WEBHOOK HIT]');
  res.sendStatus(200);
});

/* =========================================================
   🔹 起動
========================================================= */
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
