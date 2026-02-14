// routes/webhook.js
const crypto = require("crypto");

// LINE署名検証（Channel Secretで検証）
function validateSignature(rawBody, signature, channelSecret) {
  if (!rawBody || !signature || !channelSecret) return false;

  const hash = crypto
    .createHmac("sha256", channelSecret)
    .update(rawBody)
    .digest("base64");

  return hash === signature;
}

module.exports = async (req, res) => {
  try {
    // LINEはここが超重要：rawBody(Buffer)
    const rawBody = req.rawBody;
    const signature = req.get("x-line-signature");
    const channelSecret = process.env.CHANNEL_SECRET;

    const ok = validateSignature(rawBody, signature, channelSecret);
    if (!ok) return res.status(401).send("Invalid signature");

    // ここまで来たら「Webhookは当たってる」ので200返せばOK
    // （返信処理は次のステップで足す）
    return res.status(200).send("OK");
  } catch (e) {
    console.error("Webhook error:", e);
    return res.status(500).send("Error");
  }
};
