const express = require("express");

const apiRouter = require("./routes/api");
const webhookRouter = require("./routes/webhook");

const app = express();

// まずは生存確認（Render/ブラウザで開ける）
app.get("/health", (req, res) => res.status(200).send("ok"));

// JSON系の通常APIはこれ
app.use(express.json());

// あなたの通常API
app.use("/api", apiRouter);

// LINE Webhook（ここが最重要）
app.use("/webhook", webhookRouter);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
