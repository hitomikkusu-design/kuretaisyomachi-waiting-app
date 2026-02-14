const express = require("express");
const crypto = require("crypto");
const { replyText } = require("../services/lineService");

const router = express.Router();

// LINE署名検証
function validateSignature(rawBody, signature, channelSecret) {
  if (!signature || !channelSecret) return false;
  const hash = crypto
    .createHmac("sha256", channelSecret)
    .update(rawBody)
    .digest("base64");
  return hash === signature;
}

// ⚠️ LINEは「生のbody」で署名を作るので raw が必要
router.post("/", express.raw({ type: "application/json" }), async (req, res) => {
  try {
    const rawBody = req.body; // Buffer
    const signature = req.get("x-line-signature");
    const secret = process.env.LINE_CHANNEL_SECRET;

    const ok = validateSignature(rawBody, signature, secret);
    if (!ok) return res.status(401).send("Invalid signature");

    const body = JSON.parse(rawBody.toString("utf8"));

    // 何が来てもまず200返す（LINEはここが命）
    res.status(200).send("OK");

    // メッセージが来た時だけ返信（必要なら外す）
    const events = body.events || [];
    for (const ev of events) {
      if (ev.type === "message" && ev.message?.type === "text") {
        await replyText(ev.replyToken, "順番受付したで！7分以内に来てや〜");
      }
    }
  } catch (e) {
    console.error(e);
    // 例外でも200に寄せたいならここも200でもいい
    return res.status(500).send("error");
  }
});

module.exports = router;
