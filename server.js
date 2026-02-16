const express = require("express");
const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json());

app.get("/", (req, res) => {
  res.status(200).send("Server OK");
});

app.post("/webhook", (req, res) => {
  console.log("Webhook received");
  res.status(200).send("OK");
});

app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
