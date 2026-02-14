require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");

const app = express();
const PORT = process.env.PORT || 10000;

// LINE署名検証用（raw body 必須）
app.use(
  bodyParser.raw({
    type: "*/*",
  })
);

// ここ超重要👇
const webhook = require("./routes/webhook");

// エンドポイント登録
app.post("/webhook", webhook);

// 確認用
app.get("/", (req, res) => {
  res.send("Server is running");
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
