// routes/api.js
const express = require('express');
const router = express.Router();

// ※あなたの構成に合わせてパスはこのままでOKな想定
//   もし models / services のファイル名が違ったら「そこだけ」合わせてね
const queueModel = require('../models/queueModel');
const lineService = require('../services/lineService');

// ─────────────────────────────────────────
// Health check（動作確認用）
// ─────────────────────────────────────────
router.get('/health', (req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// ─────────────────────────────────────────
// Call Customer (Admin)
// ─────────────────────────────────────────
router.post('/call', async (req, res) => {
  try {
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ error: 'id is required' });

    // updateStatus が async の可能性が高いので await
    const ticket = await queueModel.updateStatus(id, 'called');
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

    // 土佐弁メッセージ（ここを好きに調整してOK）
    const message =
      `順番きたき！\n` +
      `今から7分以内に来てや。\n` +
      `遅れそうやったら、このLINEに返信してや。\n` +
      `整理番号：${ticket.id}`;

    if (ticket.lineUserId) {
      await lineService.pushMessage(ticket.lineUserId, message);
    } else {
      console.log(`Customer ${ticket.id} has no LINE linked.`);
    }

    res.json({ success: true, ticket });
  } catch (err) {
    console.error('POST /call error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

// ─────────────────────────────────────────
// Complete (Admin)
// ─────────────────────────────────────────
router.post('/complete', async (req, res) => {
  try {
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ error: 'id is required' });

    const ticket = await queueModel.updateStatus(id, 'completed');
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

    res.json({ success: true, ticket });
  } catch (err) {
    console.error('POST /complete error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

module.exports = router;
