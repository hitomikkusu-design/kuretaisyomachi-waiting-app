// Call Customer (Admin)
router.post('/call', async (req, res) => {
  try {
    const { id } = req.body;

    if (!id) {
      return res.status(400).json({ error: 'IDがありません' });
    }

    const ticket = queueModel.updateStatus(id, 'called');

    if (!ticket) {
      return res.status(404).json({ error: 'Ticket not found' });
    }

    console.log('=== CALL TRIGGERED ===');
    console.log('Ticket ID:', ticket.id);
    console.log('LINE User ID:', ticket.lineUserId);

    if (ticket.lineUserId) {

      const message = `【久礼大正町市場】

順番来たき！🐟
今から5分以内に来てや〜

遅れそうやったら
このLINEに返信してや🙏

整理番号：${ticket.id}`;

      console.log('Sending message:', message);

      await lineService.pushMessage(ticket.lineUserId, message);

      console.log('Message sent successfully');

    } else {
      console.log(`Customer ${ticket.id} has no LINE linked`);
    }

    res.json({ success: true, ticket });

  } catch (error) {
    console.error('CALL ERROR:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});
