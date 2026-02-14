const express = require("express");

const apiRoute = require("../routes/api");
const webhookRoute = require("../routes/webhook");

const app = express();

// LINE署名検証で「生のbody」が必要なので webhook だけ raw を先に当てる
app.post("/webhook", express.raw({ type: "*/*" }), webhookRoute);

// それ以外は通常のJSON
app.use(express.json());

// 疎通確認
app.get("/", (req, res) => res.status(200).send("OK"));

// API
app.use("/api", apiRoute);

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
