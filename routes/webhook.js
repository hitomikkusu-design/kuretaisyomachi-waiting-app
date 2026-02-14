// routes/webhook.js
const crypto = require("crypto");
const lineService = require("../services/lineService");

// LINE署名検証（Channel secret で検証）
function validateSignature(rawBody, signature, channelSecret) {
  if (!signature || !channelSecret) return false;
  const hash = crypto
    .createHmac("sha256", channelSecret)
    .update(rawBody)
    .digest("base64");
  return hash === signature;
}

module.exports = async (req, res) => {
  try {
    const rawBody = req.body; // Buffer
    const signature = req.get("x-line-signature");

    const ok = validateSignature(rawBody, signature, process.env.CHANNEL_SECRET);
    if (!ok) return res.status(401).send("Invalid signature");

    const body = JSON.parse(rawBody.toString("utf8"));

    // follow時に userId を保存したいならここで拾う（今はログだけ）
    console.log("LINE webhook received:", JSON.stringify(body));

    // とりあえず200返す（ここが200じゃないとLINEがエラー出す）
    return res.status(200).send("OK");
  } catch (e) {
    console.log("Webhook error:", e);
    return res.status(200).send("OK"); // LINEはまず200返すのが大事
  }
};
