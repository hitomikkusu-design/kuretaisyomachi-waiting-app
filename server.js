'use strict';

const express = require('express');
const crypto = require('crypto');
const https = require('https');
const fs = require('fs');
const path = require('path');

// ── 環境変数 ──
const PORT = process.env.PORT || 3000;
const CHANNEL_ACCESS_TOKEN = process.env.CHANNEL_ACCESS_TOKEN || '';
const CHANNEL_SECRET = process.env.CHANNEL_SECRET || '';
const ADMIN_USER_ID = process.env.ADMIN_USER_ID || '';
const STORE_NAME = process.env.STORE_NAME || '大正町市場';
const LINE_ADD_FRIEND_URL = process.env.LINE_ADD_FRIEND_URL || '';

// ── 順番待ちキュー（インメモリ） ──
let queue = [];
const BACKUP_FILE = path.join(__dirname, 'queue_backup.json');

// 起動時にバックアップから復元を試みる
try {
  if (fs.existsSync(BACKUP_FILE)) {
    const data = fs.readFileSync(BACKUP_FILE, 'utf8');
    queue = JSON.parse(data);
    console.log(`[起動] バックアップから ${queue.length} 件復元しました`);
  }
} catch (e) {
  console.log('[起動] バックアップ復元スキップ:', e.message);
  queue = [];
}

// キュー変更時にファイルに書き出す
function saveBackup() {
  try {
    fs.writeFileSync(BACKUP_FILE, JSON.stringify(queue, null, 2), 'utf8');
  } catch (e) {
    // Render無料プランではディスク書き込み失敗する場合あり。無視してOK
  }
}

// ── Express アプリ ──
const app = express();

// Webhook用: rawBodyを保持しつつJSONパース
app.use('/webhook', express.raw({ type: '*/*' }));
// フォーム用
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ── ヘルスチェック ──
app.get('/', (req, res) => {
  res.send(`${STORE_NAME} 順番待ちシステム稼働中 - 待ち: ${queue.length}組`);
});

// ── 待ち状況ページ ──
app.get('/status', (req, res) => {
  const html = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${STORE_NAME} - 待ち状況</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,"Hiragino Sans",sans-serif;background:#f0f2f5;min-height:100vh;display:flex;justify-content:center;align-items:center}
.card{background:#fff;border-radius:16px;padding:40px;text-align:center;box-shadow:0 2px 12px rgba(0,0,0,0.1);max-width:400px;width:90%}
h1{color:#06c755;font-size:1.3em;margin-bottom:20px}
.count{font-size:4em;font-weight:bold;color:#333;margin:20px 0}
.unit{font-size:0.5em;color:#666}
.note{color:#999;font-size:0.85em;margin-top:16px}
</style>
</head>
<body>
<div class="card">
  <h1>${STORE_NAME}</h1>
  <p>現在の待ち組数</p>
  <div class="count">${queue.length}<span class="unit">組</span></div>
  <p class="note">このページは手動更新してください</p>
</div>
</body>
</html>`;
  res.send(html);
});

// ── 受付ページ（LINE友だち追加誘導 + フォーム併用） ──
app.get('/form', (req, res) => {
  const lineBtn = LINE_ADD_FRIEND_URL
    ? `<a href="${LINE_ADD_FRIEND_URL}" class="line-btn">LINE友だち追加して受付する</a>`
    : `<p class="line-search">LINE公式アカウントで<br>「${STORE_NAME}」を検索して友だち追加</p>`;

  const html = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${STORE_NAME} - 順番待ち受付</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,"Hiragino Sans",sans-serif;background:#f0f2f5;min-height:100vh;display:flex;justify-content:center;align-items:flex-start;padding:20px}
.card{background:#fff;border-radius:16px;padding:32px;box-shadow:0 2px 12px rgba(0,0,0,0.1);max-width:420px;width:100%;margin-top:20px}
h1{color:#06c755;font-size:1.3em;text-align:center;margin-bottom:4px}
.wait-now{text-align:center;color:#666;font-size:0.95em;margin-bottom:20px}
.wait-now strong{color:#06c755;font-size:1.3em}
.section-title{font-weight:bold;color:#333;font-size:1em;margin-bottom:12px;padding-bottom:8px;border-bottom:2px solid #06c755}
.recommend{background:#e8f5e9;color:#2e7d32;font-size:0.75em;padding:2px 8px;border-radius:4px;margin-left:6px}
.line-btn{display:block;width:100%;padding:16px;background:#06c755;color:#fff;border:none;border-radius:10px;font-size:1.1em;font-weight:bold;text-align:center;text-decoration:none;margin-bottom:12px}
.line-btn:active{background:#05a648}
.line-search{text-align:center;background:#e8f5e9;padding:16px;border-radius:10px;color:#333;font-size:0.95em;margin-bottom:12px;line-height:1.6}
.steps{background:#f8f9fa;border-radius:10px;padding:16px;margin-bottom:24px;font-size:0.9em;line-height:1.8;color:#555}
.steps .step{margin-bottom:4px}
.divider{text-align:center;color:#aaa;font-size:0.85em;margin:24px 0 16px;position:relative}
.divider::before,.divider::after{content:'';position:absolute;top:50%;width:35%;height:1px;background:#ddd}
.divider::before{left:0}
.divider::after{right:0}
label{display:block;font-weight:bold;color:#333;margin-bottom:6px;font-size:0.95em}
input,select{width:100%;padding:12px;border:2px solid #ddd;border-radius:10px;font-size:1em;margin-bottom:16px;appearance:none;-webkit-appearance:none}
input:focus,select:focus{outline:none;border-color:#06c755}
.form-submit{width:100%;padding:14px;background:#888;color:#fff;border:none;border-radius:10px;font-size:1em;font-weight:bold;cursor:pointer}
.form-submit:active{background:#666}
.form-note{text-align:center;color:#e65100;font-size:0.8em;margin-top:8px;line-height:1.5}
</style>
</head>
<body>
<div class="card">
  <h1>${STORE_NAME}</h1>
  <p class="wait-now">現在の待ち <strong>${queue.length}</strong> 組</p>

  <p class="section-title">LINE受付<span class="recommend">おすすめ</span></p>
  ${lineBtn}
  <div class="steps">
    <div class="step">1. 上のボタンでLINE友だち追加</div>
    <div class="step">2. トーク画面で「受付 名前 人数」と送信</div>
    <div class="step">&nbsp;&nbsp;&nbsp;例:「受付 山田 3」</div>
    <div class="step">3. 順番が来たらLINEでお知らせ!</div>
  </div>

  <div class="divider">LINE以外で受付</div>
  <p class="section-title">フォーム受付</p>
  <form method="POST" action="/form">
    <label for="name">お名前</label>
    <input type="text" id="name" name="name" placeholder="例: 山田" required maxlength="20">
    <label for="party">人数</label>
    <select id="party" name="party">
      <option value="1">1名</option>
      <option value="2" selected>2名</option>
      <option value="3">3名</option>
      <option value="4">4名</option>
      <option value="5">5名</option>
      <option value="6">6名以上</option>
    </select>
    <button type="submit" class="form-submit">フォームで受付する</button>
    <p class="form-note">※フォーム受付ではLINE通知が届きません<br>お店の近くでお待ちください</p>
  </form>
</div>
</body>
</html>`;
  res.send(html);
});

// ── フォーム送信処理 ──
app.post('/form', (req, res) => {
  const name = (req.body.name || '').trim().substring(0, 20);
  const party = parseInt(req.body.party, 10) || 1;

  if (!name) {
    return res.redirect('/form');
  }

  const entry = {
    id: Date.now().toString(36),
    name: name,
    party: party,
    source: 'QR',
    time: new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' }),
    timestamp: Date.now()
  };
  queue.push(entry);
  saveBackup();

  const position = queue.length;

  // 管理者にLINE通知（非同期、エラーでも受付は成功させる）
  if (ADMIN_USER_ID && CHANNEL_ACCESS_TOKEN) {
    pushMessage(ADMIN_USER_ID, `🔔 QR受付\n${name}さん ${party}名\n現在 ${position}組待ち`).catch(() => {});
  }

  const html = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>受付完了</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,"Hiragino Sans",sans-serif;background:#f0f2f5;min-height:100vh;display:flex;justify-content:center;align-items:center;padding:20px}
.card{background:#fff;border-radius:16px;padding:40px;text-align:center;box-shadow:0 2px 12px rgba(0,0,0,0.1);max-width:420px;width:100%}
.check{font-size:3em;margin-bottom:16px}
h1{color:#06c755;font-size:1.3em;margin-bottom:16px}
.info{font-size:1.1em;color:#333;margin-bottom:8px}
.position{font-size:2.5em;font-weight:bold;color:#06c755;margin:16px 0}
.note{color:#999;font-size:0.85em;margin-top:20px;line-height:1.6}
</style>
</head>
<body>
<div class="card">
  <div class="check">✅</div>
  <h1>受付完了しました</h1>
  <p class="info">${name}さん（${party}名）</p>
  <p>あなたの順番</p>
  <div class="position">${position}<span style="font-size:0.4em;color:#666">番目</span></div>
  <p class="note">順番が近づきましたらお呼びします。<br>この画面を閉じても大丈夫です。</p>
</div>
</body>
</html>`;
  res.send(html);
});

// ── LINE Webhook ──
app.post('/webhook', (req, res) => {
  // まず200を返す（LINE platformは3秒でタイムアウトする）
  res.status(200).send('OK');

  const body = req.body;

  // 署名検証
  if (CHANNEL_SECRET) {
    const signature = req.headers['x-line-signature'];
    const hash = crypto.createHmac('SHA256', CHANNEL_SECRET).update(body).digest('base64');
    if (signature !== hash) {
      console.log('[Webhook] 署名不一致 - 無視');
      return;
    }
  }

  let parsed;
  try {
    parsed = JSON.parse(body.toString());
  } catch (e) {
    console.log('[Webhook] JSONパース失敗');
    return;
  }

  if (!parsed.events || !Array.isArray(parsed.events)) return;

  parsed.events.forEach((event) => {
    handleEvent(event).catch((err) => {
      console.error('[handleEvent] エラー:', err.message);
    });
  });
});

// ── イベント処理 ──
async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') return;

  const userId = event.source.userId;
  const text = event.message.text.trim();
  const replyToken = event.replyToken;
  const isAdmin = userId === ADMIN_USER_ID;

  // ── 管理者コマンド ──
  if (isAdmin) {
    if (text === '次') {
      if (queue.length === 0) {
        return replyMessage(replyToken, '待ちリストは空です');
      }
      const next = queue.shift();
      saveBackup();
      const msg = `📢 次のお客様\n${next.name}さん（${next.party}名）\n\n残り ${queue.length}組`;

      // LINE受付の場合、お客さんにも通知
      if (next.userId) {
        pushMessage(next.userId, `🎉 ${next.name}さん、順番です！\nお店にお越しください。`).catch(() => {});
      }

      return replyMessage(replyToken, msg);
    }

    if (text === '一覧') {
      if (queue.length === 0) {
        return replyMessage(replyToken, '現在待ちはありません');
      }
      const header = `📋 待ちリスト（${queue.length}組）\n`;
      const list = queue.slice(0, 5).map((e, i) =>
        `${i + 1}. ${e.name}さん ${e.party}名 (${e.source}) ${e.time}`
      ).join('\n');
      const more = queue.length > 5 ? `\n...他 ${queue.length - 5}組` : '';
      return replyMessage(replyToken, header + list + more);
    }

    if (text === '全消し') {
      const count = queue.length;
      queue = [];
      saveBackup();
      return replyMessage(replyToken, `🗑 ${count}件の待ちを全削除しました`);
    }
  }

  // ── 一般コマンド ──
  // 「受付」「受付 山田」「受付 山田 3」に対応
  if (text === '受付' || text.startsWith('受付 ') || text.startsWith('受付　')) {
    const parts = text.split(/[\s　]+/);  // 半角・全角スペース両対応
    const name = parts[1] || 'LINE受付';
    const partyRaw = (parts[2] || '1').replace(/[名人組]/g, '');  // 「3名」→「3」
    const party = Math.min(Math.max(parseInt(partyRaw, 10) || 1, 1), 20);

    const entry = {
      id: Date.now().toString(36),
      name: name.substring(0, 20),
      party: party,
      source: 'LINE',
      userId: userId,
      time: new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' }),
      timestamp: Date.now()
    };
    queue.push(entry);
    saveBackup();
    const position = queue.length;

    // 管理者に通知
    if (ADMIN_USER_ID && CHANNEL_ACCESS_TOKEN && userId !== ADMIN_USER_ID) {
      pushMessage(ADMIN_USER_ID, `🔔 LINE受付\n${name}さん ${party}名\n現在 ${position}組待ち`).catch(() => {});
    }

    let replyText = `✅ 受付しました\n${name}さん ${party}名\nあなたは ${position}番目です\n順番が来たらLINEでお知らせします`;
    if (parts.length === 1) {
      replyText += `\n\n💡 名前・人数つきで受付もできます\n例:「受付 山田 3」`;
    }

    return replyMessage(replyToken, replyText);
  }

  if (text === '状況' || text === '確認') {
    const myEntries = queue.filter((e) => e.userId === userId);
    if (myEntries.length === 0) {
      return replyMessage(replyToken, `現在の受付はありません\n「受付」と送ると順番待ちできます`);
    }
    const myIndex = queue.findIndex((e) => e.userId === userId);
    return replyMessage(replyToken, `あなたは現在 ${myIndex + 1}/${queue.length} 番目です`);
  }

  // ヘルプ（何を送っても返す）
  let helpMsg = `${STORE_NAME} 順番待ちシステム\n\n`;
  helpMsg += `「受付」→ 順番待ちに並ぶ\n`;
  helpMsg += `「受付 名前 人数」→ 名前と人数つきで受付\n`;
  helpMsg += `　例: 受付 山田 3\n`;
  helpMsg += `「状況」→ 自分の順番を確認\n`;
  if (isAdmin) {
    helpMsg += `\n--- 管理者メニュー ---\n`;
    helpMsg += `「次」→ 次のお客様を呼ぶ\n`;
    helpMsg += `「一覧」→ 待ちリスト表示\n`;
    helpMsg += `「全消し」→ リスト全削除\n`;
  }
  return replyMessage(replyToken, helpMsg);
}

// ── LINE API: Reply ──
function replyMessage(replyToken, text) {
  return callLineApi('/v2/bot/message/reply', {
    replyToken: replyToken,
    messages: [{ type: 'text', text: text }]
  });
}

// ── LINE API: Push ──
function pushMessage(userId, text) {
  return callLineApi('/v2/bot/message/push', {
    to: userId,
    messages: [{ type: 'text', text: text }]
  });
}

// ── LINE API 共通呼び出し ──
function callLineApi(apiPath, body) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(body);
    const options = {
      hostname: 'api.line.me',
      path: apiPath,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${CHANNEL_ACCESS_TOKEN}`,
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve(data);
        } else {
          console.error(`[LINE API] ${apiPath} status=${res.statusCode} body=${data}`);
          reject(new Error(`LINE API error: ${res.statusCode}`));
        }
      });
    });

    req.on('error', (e) => {
      console.error(`[LINE API] リクエストエラー: ${e.message}`);
      reject(e);
    });

    req.write(postData);
    req.end();
  });
}

// ── サーバー起動 ──
app.listen(PORT, () => {
  console.log(`=== ${STORE_NAME} 順番待ちシステム ===`);
  console.log(`ポート: ${PORT}`);
  console.log(`受付フォーム: /form`);
  console.log(`待ち状況: /status`);
  console.log(`Webhook: /webhook`);
  console.log(`管理者ID: ${ADMIN_USER_ID ? '設定済み' : '未設定'}`);
  console.log(`トークン: ${CHANNEL_ACCESS_TOKEN ? '設定済み' : '未設定'}`);
  console.log(`友だち追加URL: ${LINE_ADD_FRIEND_URL ? '設定済み' : '未設定'}`);
  console.log('================================');
});
