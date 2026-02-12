const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, '../data/queue.json');

const readQueue = () => {
    try {
        if (!fs.existsSync(DATA_FILE)) {
            return [];
        }
        const data = fs.readFileSync(DATA_FILE, 'utf8');
        return JSON.parse(data);
    } catch (err) {
        console.error('Error reading queue data:', err);
        return [];
    }
};

const writeQueue = (data) => {
    try {
        fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
    } catch (err) {
        console.error('Error writing queue data:', err);
    }
};

const addToQueue = (name, count, phone) => {
    const queue = readQueue();
    const newId = queue.length > 0 ? Math.max(...queue.map(i => i.id)) + 1 : 1;
    const newItem = {
        id: newId,
        name,
        count,
        phone,
        status: 'waiting', // waiting, called, completed
        lineUserId: null,
        checkinTime: new Date().toISOString()
    };
    queue.push(newItem);
    writeQueue(queue);
    return newItem;
};

const linkLineUser = (ticketId, userId) => {
    const queue = readQueue();
    const item = queue.find(q => q.id === parseInt(ticketId));
    if (item) {
        item.lineUserId = userId;
        writeQueue(queue);
        return true;
    }
    return false;
};

const updateStatus = (id, status) => {
    const queue = readQueue();
    const item = queue.find(q => q.id === parseInt(id));
    if (item) {
        item.status = status;
        writeQueue(queue);
        return item;
    }
    return null;
};

module.exports = {
    readQueue,
    addToQueue,
    linkLineUser,
    updateStatus
};
