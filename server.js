require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');
const apiRoutes = require('./routes/api');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api', apiRoutes);

// LIFF ID Endpoint for frontend
app.get('/api/liff-id', (req, res) => {
    res.json({ liffId: process.env.LIFF_ID });
});

app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
console.log("BOOT: server started", new Date().toISOString());
console.log("ENV CHECK LIFF_ID?", !!process.env.LIFF_ID);
console.log("ENV CHECK ACCESS TOKEN?", !!process.env.LINE_CHANNEL_ACCESS_TOKEN);
console.log("ENV CHECK SECRET?", !!process.env.LINE_CHANNEL_SECRET);
