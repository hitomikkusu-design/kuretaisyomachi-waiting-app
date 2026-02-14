// services/lineService.js
require('dotenv').config(); // 念のためここでも読む（既に読めててもOK）

const line = require('@line/bot-sdk');

// .env 側はこういう名前で揃える：
// CHANNEL_ACCESS_TOKEN=xxxxx
// CHANNEL_SECRET=xxxxx
const config = {
    channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
    channelSecret: process.env.CHANNEL_SECRET,
};

// 起動時チェック（ここで落ちるなら.envが読めてない or 名前ズレ）
if (!config.channelAccessToken) {
    throw new Error('CHANNEL_ACCESS_TOKEN is missing. Check .env');
}
if (!config.channelSecret) {
    throw new Error('CHANNEL_SECRET is missing. Check .env');
}

const client = new line.Client(config);

// userId に push する関数
async function pushMessage(userId, text) {
    try {
        await client.pushMessage(userId, {
            type: 'text',
            text: text,
        });
        console.log(`Pushed message to ${userId}: ${text}`);
        return true;
    } catch (error) {
        console.error('Failed to push message:', error);
        return false;
    }
}

module.exports = {
    pushMessage,
    client,
};
