// src/server.js
require("dotenv").config();

const express = require("express");
const path = require("path");

const api = require("../routes/api");
const webhook = require("../routes/webhook");

const app = express();

// 🔸 LINE署名検証のため raw body を保持
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf; // Buffer
    },
  })
);

// health check
app.get("/", (req, res) => res.status(200).send("OK"));

// API
app.use("/api", api);

// Webhook（POST本番）
app.post("/webhook", webhook);

// Webhook URL検証対策（GET/HEADも200返す）
app.get("/webhook", (req, res) => res.status(200).send("OK"));
app.head("/webhook", (req, res) => res.status(200).end());

const port = process.env.PORT || 10000;
app.listen(port, () => {
  console.log("BOOT: server started");
  console.log("Detected service running on port", port);
  console.log("==> Your service is live 🎉");
});
