const express = require('express');
const router = express.Router();
const queueModel = require('../models/queueModel');
const lineService = require('../services/lineService');

// Get current queue (for Admin)
router.get('/queue', (req, res) => {
    const queue = queueModel.readQueue();
    const waiting = queue.filter(q => q.status !== 'completed'); // Show waiting and called
    res.json(waiting);
});

// Check-in (User)
router.post('/checkin', (req, res) => {
    const { name, count, phone } = req.body;
    if (!name || !count) {
        return res.status(400).json({ error: 'Name and count are required' });
    }
    const ticket = queueModel.addToQueue(name, count, phone);
    res.json(ticket);
});

// Link LINE User
router.post('/link-line', (req, res) => {
    const { ticketId, userId } = req.body;
    if (!ticketId || !userId) {
        return res.status(400).json({ error: 'Ticket ID and User ID are required' });
    }
    const success = queueModel.linkLineUser(ticketId, userId);
    if (success) {
        res.json({ success: true });
    } else {
        res.status(404).json({ error: 'Ticket not found' });
    }
});

// Call Customer (Admin)
router.post('/call', async (req, res) => {
    const { id } = req.body;
    const ticket = queueModel.updateStatus(id, 'called');

    if (!ticket) {
        return res.status(404).json({ error: 'Ticket not found' });
    }

    if (ticket.lineUserId) {
        const message = `順番きたで！\n今から7分以内においでや。\n遅れそうなら返信してね。\n整理番号：${ticket.id}`;
        await lineService.pushMessage(ticket.lineUserId, message);
    } else {
        console.log(`Customer ${ticket.id} has no LINE linked.`);
    }

    res.json({ success: true, ticket });
});

// Complete (Admin)
router.post('/complete', (req, res) => {
    const { id } = req.body;
    const ticket = queueModel.updateStatus(id, 'completed');
    res.json({ success: true, ticket });
});

module.exports = router;
