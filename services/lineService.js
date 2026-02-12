const line = require('@line/bot-sdk');

const config = {
    channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
    channelSecret: process.env.LINE_CHANNEL_SECRET
};

const client = new line.Client(config);

const pushMessage = async (userId, text) => {
    try {
        // Tosa dialect message construction can happen here or be passed in
        await client.pushMessage({
            to: userId,
            messages: [{ type: 'text', text: text }]
        });
        console.log(`Pushed message to ${userId}: ${text}`);
        return true;
    } catch (error) {
        console.error(`Failed to push message to ${userId}`, error);
        return false;
    }
};

module.exports = {
    pushMessage
};
