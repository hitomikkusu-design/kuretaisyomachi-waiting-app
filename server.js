// server.js
const express = require("express");
const path = require("path");
require("dotenv").config();

const app = express();

// ✅ LINE Webhookは raw body が要るので、webhookだけ raw で受ける
app.use("/webhook", express.raw({ type: "*/*" }));

// ✅ 通常APIはJSONでOK
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ---- routes
const apiRoutes = require("./routes/api");
app.use("/api", apiRoutes);

// ✅ LINE webhook endpoint（GETも200返す。LINEの疎通確認/ブラウザ確認用）
app.get("/webhook", (req, res) => res.status(200).send("OK"));
app.post("/webhook", require("./routes/webhook"));

// ---- static
app.use(express.static(path.join(__dirname, "public")));

// health
app.get("/health", (req, res) => res.status(200).json({ ok: true }));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`BOOT: server started ${new Date().toISOString()}`);
  console.log(`Server is running on http://localhost:${PORT}`);
});
