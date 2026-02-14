require("dotenv").config();

const express = require("express");
const bodyParser = require("body-parser");

const app = express();
const PORT = process.env.PORT || 10000;

// raw body を保持（LINE署名検証用）
app.use(
  bodyParser.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);

// ルート読み込み
const apiRoute = require("../routes/api");
const webhookRoute = require("../routes/webhook");

// ルーティング
app.use("/api", apiRoute);
app.use("/webhook", webhookRoute);

app.get("/", (req, res) => {
  res.send("Server is running 🚀");
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
