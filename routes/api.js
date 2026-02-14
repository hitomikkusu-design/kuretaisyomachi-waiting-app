// routes/api.js
const express = require("express");
const router = express.Router();

router.get("/liff-id", (req, res) => {
  // ひとみさんのログで LIFF_ID true になってたので env から返す
  res.status(200).json({ liffId: process.env.LIFF_ID || "" });
});

// テスト用（Renderで生存確認したい時）
router.get("/ping", (req, res) => res.status(200).send("pong"));

module.exports = router;
