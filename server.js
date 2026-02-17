'use strict';

const express = require('express');
const crypto  = require('crypto');
const Database = require('better-sqlite3');
const QRCode  = require('qrcode');
const path    = require('path');

// ══════════════════════════════════════════
//  環境変数
// ══════════════════════════════════════════
const PORT       = process.env.PORT || 3000;
const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || process.env.CHANNEL_ACCESS_TOKEN || '';
const LINE_SECRET = process.env.LINE_CHANNEL_SECRET || process.env.CHANNEL_SECRET || '';
const BASE_URL   = (process.env.BASE_URL || '').replace(/\/$/, '');
const STORE_NAME = process.env.STORE_NAME || '久礼大正町市場';

// ══════════════════════════════════════════
//  LINE Bot SDK（v7 / v8+ 両対応）
// ══════════════════════════════════════════
let line, lineClient, sdkNew = false;
try {
  line = require('@line/bot-sdk');
  if (LINE_TOKEN) {
    if (line.messagingApi && line.messagingApi.MessagingApiClient) {
      lineClient = new line.messagingApi.MessagingApiClient({ channelAccessToken: LINE_TOKEN });
      sdkNew = true;
    } else if (line.Client) {
      lineClient = new line.Client({ channelAccessToken: LINE_TOKEN, channelSecret: LINE_SECRET });
    }
    console.log('[LINE] SDK OK (' + (sdkNew ? 'v8+' : 'v7') + ')');
  }
} catch (e) {
  console.log('[LINE] SDK読込スキップ:', e.message);
}

async function pushMsg(userId, text) {
  if (!lineClient) return;
  const m = [{ type: 'text', text }];
  try {
    sdkNew
      ? await lineClient.pushMessage({ to: userId, messages: m })
      : await lineClient.pushMessage(userId, m);
  } catch (e) { console.error('[LINE push]', e.message); }
}

async function replyMsg(token, text) {
  if (!lineClient) return;
  const m = [{ type: 'text', text }];
  try {
    sdkNew
      ? await lineClient.replyMessage({ replyToken: token, messages: m })
      : await lineClient.replyMessage(token, m);
  } catch (e) { console.error('[LINE reply]', e.message); }
}

// ══════════════════════════════════════════
//  SQLite
// ══════════════════════════════════════════
const db = new Database(path.join(__dirname, 'waitlist.db'));
db.pragma('journal_mode = WAL');
db.exec(`CREATE TABLE IF NOT EXISTS tickets (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  phone       TEXT DEFAULT '',
  people      INTEGER DEFAULT 1,
  status      TEXT DEFAULT 'waiting',
  line_user_id TEXT,
  created_at  TEXT DEFAULT (datetime('now','localtime'))
)`);

const Q = {
  insert:    db.prepare('INSERT INTO tickets (name, phone, people) VALUES (?, ?, ?)'),
  get:       db.prepare('SELECT * FROM tickets WHERE id = ?'),
  setStatus: db.prepare('UPDATE tickets SET status = ? WHERE id = ?'),
  linkLine:  db.prepare('UPDATE tickets SET line_user_id = ? WHERE id = ?'),
  del:       db.prepare('DELETE FROM tickets WHERE id = ?'),
  waiting:   db.prepare("SELECT * FROM tickets WHERE status='waiting' ORDER BY id"),
  called:    db.prepare("SELECT * FROM tickets WHERE status='called' ORDER BY id"),
  cntWait:   db.prepare("SELECT COUNT(*) as c FROM tickets WHERE status='waiting'"),
  position:  db.prepare("SELECT COUNT(*) as p FROM tickets WHERE status='waiting' AND id < ?"),
  byLineUsr: db.prepare("SELECT * FROM tickets WHERE line_user_id=? AND status IN('waiting','called') ORDER BY id LIMIT 1"),
  clearDone: db.prepare("DELETE FROM tickets WHERE status='done'"),
};

// ══════════════════════════════════════════
//  Express セットアップ
// ══════════════════════════════════════════
const app = express();
const rawParser  = express.raw({ type: '*/*' });
const formParser = express.urlencoded({ extended: false });
const jsonParser = express.json();

app.use((req, res, next) => {
  if (req.path === '/webhook') return rawParser(req, res, next);
  formParser(req, res, () => jsonParser(req, res, next));
});

function baseUrl(req) {
  if (BASE_URL) return BASE_URL;
  const p = req.headers['x-forwarded-proto'] || req.protocol;
  const h = req.headers['x-forwarded-host'] || req.get('host');
  return `${p}://${h}`;
}

// ══════════════════════════════════════════
//  HTML レイアウト共通
// ══════════════════════════════════════════
function layout(title, body, extraCss) {
  return `<!DOCTYPE html><html lang="ja"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,"Hiragino Sans",sans-serif;background:#f0f2f5;min-height:100vh}
.wrap{max-width:520px;margin:0 auto;padding:16px}
.card{background:#fff;border-radius:16px;padding:28px;box-shadow:0 2px 12px rgba(0,0,0,.08);margin-bottom:14px}
.btn{display:inline-block;padding:8px 16px;border:none;border-radius:8px;font-size:.9em;font-weight:bold;cursor:pointer;text-decoration:none;color:#fff}
.bg{background:#06c755}.bo{background:#ff9800}.br{background:#e53935}.bg2{background:#888}
.btn:active{opacity:.8}
${extraCss || ''}
</style></head><body><div class="wrap">${body}</div></body></html>`;
}

// ══════════════════════════════════════════
//  GET /
// ══════════════════════════════════════════
app.get('/', (_req, res) => res.send('Server running'));

// ══════════════════════════════════════════
//  GET /form ── 受付フォーム
// ══════════════════════════════════════════
app.get('/form', (_req, res) => {
  const w = Q.cntWait.get().c;
  res.send(layout(`${STORE_NAME} 受付`, `
<div class="card" style="text-align:center">
  <h1 class="g">${STORE_NAME}</h1>
  <p class="sub">現在の待ち <b class="g big">${w}</b> 組</p>
  <form method="POST" action="/register" style="text-align:left;margin-top:20px">
    <label>お名前 <span style="color:red">*</span></label>
    <input type="text" name="name" required maxlength="20" placeholder="例: 山田">
    <label>電話番号</label>
    <input type="tel" name="phone" maxlength="20" placeholder="例: 090-1234-5678">
    <label>人数</label>
    <select name="people">
      ${[1,2,3,4,5,6,7,8].map(n=>`<option value="${n}"${n===2?' selected':''}>${n}名</option>`).join('')}
    </select>
    <button type="submit" class="btn bg" style="width:100%;padding:14px;font-size:1.1em;margin-top:12px">受付する</button>
  </form>
</div>`,
`h1.g{color:#06c755;margin-bottom:4px}
.sub{color:#666;margin-bottom:8px} .big{font-size:1.3em}
label{display:block;font-weight:bold;color:#333;margin:14px 0 4px;font-size:.95em}
input,select{width:100%;padding:12px;border:2px solid #ddd;border-radius:10px;font-size:1em}
input:focus,select:focus{outline:none;border-color:#06c755}`));
});

// ══════════════════════════════════════════
//  POST /register ── 受付登録
// ══════════════════════════════════════════
app.post('/register', (req, res) => {
  const name   = (req.body.name || '').trim().substring(0, 20);
  const phone  = (req.body.phone || '').trim().substring(0, 20);
  const people = Math.min(Math.max(parseInt(req.body.people, 10) || 1, 1), 20);
  if (!name) return res.redirect('/form');

  const info = Q.insert.run(name, phone, people);
  const id   = Number(info.lastInsertRowid);
  const pos  = Q.cntWait.get().c;

  res.send(layout('受付完了', `
<div class="card" style="text-align:center">
  <div style="font-size:3em;margin-bottom:8px">✅</div>
  <h1 style="color:#06c755">受付できたで！</h1>
  <p style="font-size:1.05em;color:#333;margin-top:12px">${name}さん（${people}名）</p>
  <div style="margin:20px 0">
    <p style="color:#666;font-size:.85em">受付番号</p>
    <div style="font-size:3.5em;font-weight:bold;color:#06c755">${id}</div>
  </div>
  <div id="pa">
    <p style="color:#666;font-size:.85em">現在の順番</p>
    <div style="font-size:2em;font-weight:bold"><span id="pos">${pos}</span><small style="color:#666"> 番目</small></div>
  </div>
  <div id="ca" style="display:none;background:#06c755;color:#fff;border-radius:12px;padding:20px;margin:16px 0;font-weight:bold;font-size:1.1em;line-height:1.6">
    順番きたで！<br>お店に来てや〜！
  </div>
  <div style="background:#fff8e1;border:2px solid #ffe082;border-radius:12px;padding:16px;margin-top:20px;text-align:left;line-height:1.8">
    <p style="font-weight:bold;color:#f57f17;margin-bottom:6px">LINE通知を受けるには</p>
    <p>1. LINE公式アカウントを友だち追加</p>
    <p>2. トークで <b style="color:#06c755">「受付 ${id}」</b> と送信</p>
    <p>3. 順番が来たらLINEでお知らせ！</p>
  </div>
  <p style="color:#aaa;font-size:.75em;margin-top:14px" id="upd">10秒ごとに自動更新中...</p>
</div>
<script>
(function(){
  var t=setInterval(function(){
    fetch("/api/position/${id}").then(function(r){return r.json()}).then(function(d){
      if(d.status==="called"){
        document.getElementById("pa").style.display="none";
        document.getElementById("ca").style.display="block";
        document.getElementById("upd").textContent="";clearInterval(t);
      }else if(d.status==="done"){
        document.getElementById("pa").innerHTML='<p style="color:#888">完了しました</p>';
        document.getElementById("upd").textContent="";clearInterval(t);
      }else{document.getElementById("pos").textContent=d.position;}
    }).catch(function(){});
  },10000);
})();
</script>`));
});

// ══════════════════════════════════════════
//  GET /status ── 待ち状況（公開）
// ══════════════════════════════════════════
app.get('/status', (_req, res) => {
  const waiting = Q.waiting.all();
  const called  = Q.called.all();

  const calledHtml = called.map(t =>
    `<div class="tk called"><span class="tn">#${t.id}</span>${t.name}さん（${t.people}名）<span class="bd bc">呼出中</span></div>`
  ).join('');

  const waitHtml = waiting.length > 0
    ? waiting.map((t, i) =>
      `<div class="tk"><span class="tn">#${t.id}</span>${t.name}さん（${t.people}名）<span class="bd">${i+1}番目</span></div>`
    ).join('')
    : '<p style="text-align:center;color:#aaa;padding:20px">現在待ちはありません</p>';

  res.send(layout(`${STORE_NAME} 待ち状況`, `
<div class="card" style="text-align:center">
  <h1 style="color:#06c755;margin-bottom:6px">${STORE_NAME}</h1>
  <p style="color:#666;margin-bottom:12px">待ち状況</p>
  <div style="font-size:3.5em;font-weight:bold;color:#333">${waiting.length}<small style="font-size:.3em;color:#666">組待ち</small></div>
</div>
${called.length ? `<div class="card"><h2 style="font-size:1em;color:#ff9800;margin-bottom:10px">呼び出し中</h2>${calledHtml}</div>` : ''}
<div class="card"><h2 style="font-size:1em;color:#333;margin-bottom:10px">待ち一覧</h2>${waitHtml}</div>
<p style="text-align:center;color:#aaa;font-size:.75em;margin-top:6px">30秒ごとに自動更新</p>
<meta http-equiv="refresh" content="30">`,
`.tk{display:flex;align-items:center;gap:8px;padding:10px 0;border-bottom:1px solid #eee;font-size:.95em}
.tk:last-child{border-bottom:none}
.tk.called{background:#fff8e1;margin:0 -8px;padding:10px 8px;border-radius:8px}
.tn{font-weight:bold;color:#06c755;min-width:40px}
.bd{margin-left:auto;font-size:.8em;color:#888;background:#f0f0f0;padding:2px 8px;border-radius:4px}
.bc{color:#ff9800;background:#fff3e0}`));
});

// ══════════════════════════════════════════
//  GET /admin ── 管理画面
// ══════════════════════════════════════════
app.get('/admin', (_req, res) => {
  const waiting = Q.waiting.all();
  const called  = Q.called.all();

  const TH = '<tr><th>No</th><th>名前</th><th>電話</th><th>人数</th><th>時刻</th><th>LINE</th><th>操作</th></tr>';

  function row(t, btns) {
    const ln = t.line_user_id ? '✅' : '-';
    const tm = t.created_at ? t.created_at.substring(11, 16) : '';
    return `<tr><td><b>#${t.id}</b></td><td>${t.name}</td><td>${t.phone||'-'}</td><td>${t.people}名</td><td>${tm}</td><td>${ln}</td><td>${btns}</td></tr>`;
  }

  const waitRows = waiting.map(t => row(t,
    `<button class="btn bg sm" onclick="act('call',${t.id})">呼出</button><button class="btn br sm" onclick="act('delete',${t.id})">削除</button>`
  )).join('');

  const callRows = called.map(t => row(t,
    `<button class="btn bo sm" onclick="act('done',${t.id})">完了</button><button class="btn bg2 sm" onclick="act('requeue',${t.id})">戻す</button><button class="btn br sm" onclick="act('delete',${t.id})">削除</button>`
  )).join('');

  res.send(layout(`${STORE_NAME} 管理`, `
<div class="card">
  <h1 style="color:#06c755;font-size:1.2em;margin-bottom:14px">${STORE_NAME} 管理画面</h1>
  <div style="display:flex;gap:10px;margin-bottom:18px">
    <div style="flex:1;text-align:center;background:#e8f5e9;padding:12px;border-radius:8px">
      <div style="font-size:2em;font-weight:bold;color:#06c755">${waiting.length}</div>
      <div style="font-size:.85em;color:#666">待ち</div>
    </div>
    <div style="flex:1;text-align:center;background:#fff3e0;padding:12px;border-radius:8px">
      <div style="font-size:2em;font-weight:bold;color:#ff9800">${called.length}</div>
      <div style="font-size:.85em;color:#666">呼出中</div>
    </div>
  </div>

  ${called.length ? `<h2 class="sh" style="color:#ff9800">呼び出し中</h2><div class="tw"><table>${TH}${callRows}</table></div><hr style="margin:16px 0;border:none;border-top:1px solid #eee">` : ''}

  <h2 class="sh">待ち一覧（${waiting.length}組）</h2>
  ${waiting.length
    ? `<div class="tw"><table>${TH}${waitRows}</table></div>`
    : '<p style="color:#aaa;text-align:center;padding:16px">待ちなし</p>'}
</div>
<div style="text-align:center;margin-top:8px">
  <a href="/admin/qr" class="btn bg" style="margin-right:6px">QR表示</a>
  <a href="/status" class="btn bg2">待ち状況</a>
</div>
<script>
async function act(a,id){
  if(a==='delete'&&!confirm('削除しますか？'))return;
  await fetch('/'+a+'/'+id,{method:'POST'});
  location.reload();
}
setTimeout(function(){location.reload()},15000);
</script>`,
`.sh{font-size:1em;color:#333;margin-bottom:8px}
.tw{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:.82em}
th{background:#f8f9fa;padding:7px 5px;text-align:left;font-size:.78em;color:#666;white-space:nowrap}
td{padding:7px 5px;border-bottom:1px solid #f0f0f0;white-space:nowrap}
.sm{padding:3px 8px;font-size:.75em;margin:1px}`));
});

// ══════════════════════════════════════════
//  GET /admin/qr ── 店頭掲示用
// ══════════════════════════════════════════
app.get('/admin/qr', async (req, res) => {
  const base     = baseUrl(req);
  const formUrl  = base + '/form';
  const statusUrl = base + '/status';

  let qrForm, qrStatus;
  try {
    qrForm   = await QRCode.toDataURL(formUrl, { width: 400, margin: 2 });
    qrStatus = await QRCode.toDataURL(statusUrl, { width: 200, margin: 2 });
  } catch (e) {
    return res.status(500).send('QR生成エラー: ' + e.message);
  }

  res.send(`<!DOCTYPE html><html lang="ja"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${STORE_NAME} QR</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,"Hiragino Sans",sans-serif;background:#fff;display:flex;justify-content:center;padding:20px}
.page{text-align:center;max-width:500px;width:100%}
h1{font-size:2em;color:#06c755;margin-bottom:6px}
.sub{font-size:1.2em;color:#333;margin-bottom:20px}
.qr-box{border:3px solid #06c755;border-radius:16px;padding:20px;display:inline-block;margin-bottom:14px}
.qr-box img{width:300px;height:300px}
.steps{background:#f8f9fa;border-radius:12px;padding:16px;margin:14px 0;text-align:left;font-size:1.05em;line-height:2}
.step{display:flex;align-items:flex-start;gap:8px}
.num{background:#06c755;color:#fff;border-radius:50%;min-width:28px;height:28px;display:flex;align-items:center;justify-content:center;font-weight:bold;font-size:.9em}
.url{color:#999;font-size:.8em;word-break:break-all;margin-top:6px}
.pbtn{display:inline-block;padding:12px 32px;background:#06c755;color:#fff;border:none;border-radius:8px;font-size:1em;cursor:pointer;margin-top:14px}
.status-qr{margin-top:28px;padding-top:20px;border-top:2px dashed #ddd}
.status-qr h2{font-size:1.2em;color:#333;margin-bottom:10px}
.status-qr img{width:200px;height:200px}
@media print{.pbtn{display:none}body{padding:0}.page{max-width:100%}}
</style></head><body>
<div class="page">
  <h1>${STORE_NAME}</h1>
  <p class="sub">順番待ち受付</p>
  <div class="qr-box"><img src="${qrForm}" alt="受付QR"></div>
  <div class="steps">
    <div class="step"><span class="num">1</span><span>上のQRコードをスマホで読み取り</span></div>
    <div class="step"><span class="num">2</span><span>名前と人数を入力して受付</span></div>
    <div class="step"><span class="num">3</span><span>LINE友だち追加で通知も受け取れます</span></div>
  </div>
  <p class="url">${formUrl}</p>
  <button class="pbtn" onclick="window.print()">このページを印刷する</button>
  <div class="status-qr">
    <h2>待ち状況の確認はこちら</h2>
    <img src="${qrStatus}" alt="状況確認QR">
    <p style="color:#666;font-size:.9em;margin-top:4px">待ち組数をリアルタイムで確認できます</p>
  </div>
</div>
</body></html>`);
});

// ══════════════════════════════════════════
//  POST /call/:id ── 呼び出し
// ══════════════════════════════════════════
app.post('/call/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const t  = Q.get.get(id);
  if (!t) return res.status(404).json({ ok: false, message: '受付番号が見つかりません' });
  if (t.status !== 'waiting') return res.status(400).json({ ok: false, message: `状態が ${t.status} です` });

  Q.setStatus.run('called', id);

  if (t.line_user_id) {
    await pushMsg(t.line_user_id, `順番きたき、7分以内に来てや〜！ 受付番号：${id}`);
  }
  res.json({ ok: true, message: `${t.name}さんを呼び出しました` });
});

// ══════════════════════════════════════════
//  POST /done/:id ── 完了
// ══════════════════════════════════════════
app.post('/done/:id', (_req, res) => {
  const id = parseInt(_req.params.id, 10);
  const t  = Q.get.get(id);
  if (!t) return res.status(404).json({ ok: false, message: '見つかりません' });
  Q.setStatus.run('done', id);
  res.json({ ok: true, message: `${t.name}さんを完了にしました` });
});

// ══════════════════════════════════════════
//  POST /requeue/:id ── 待ちに戻す
// ══════════════════════════════════════════
app.post('/requeue/:id', (_req, res) => {
  const id = parseInt(_req.params.id, 10);
  const t  = Q.get.get(id);
  if (!t) return res.status(404).json({ ok: false, message: '見つかりません' });
  Q.setStatus.run('waiting', id);
  res.json({ ok: true, message: `${t.name}さんを待ちに戻しました` });
});

// ══════════════════════════════════════════
//  POST /delete/:id ── 削除
// ══════════════════════════════════════════
app.post('/delete/:id', (_req, res) => {
  const id = parseInt(_req.params.id, 10);
  Q.del.run(id);
  res.json({ ok: true, message: '削除しました' });
});

// ══════════════════════════════════════════
//  GET /api/position/:id ── 順番確認API
// ══════════════════════════════════════════
app.get('/api/position/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const t  = Q.get.get(id);
  if (!t) return res.json({ found: false, status: 'unknown', position: 0, total: 0 });

  const total = Q.cntWait.get().c;
  if (t.status === 'called') return res.json({ found: true, status: 'called', position: 0, total });
  if (t.status === 'done')   return res.json({ found: true, status: 'done',   position: 0, total: 0 });

  const pos = Q.position.get(id).p + 1;
  res.json({ found: true, status: 'waiting', position: pos, total });
});

// ══════════════════════════════════════════
//  POST /webhook ── LINE Webhook
// ══════════════════════════════════════════
app.post('/webhook', (req, res) => {
  res.status(200).send('OK');

  const body = req.body;

  // 署名検証
  if (LINE_SECRET) {
    const sig  = req.headers['x-line-signature'];
    const hash = crypto.createHmac('SHA256', LINE_SECRET).update(body).digest('base64');
    if (sig !== hash) { console.log('[Webhook] 署名不一致'); return; }
  }

  let parsed;
  try { parsed = JSON.parse(body.toString()); } catch { return; }
  if (!parsed.events) return;

  parsed.events.forEach(ev => handleLineEvent(ev).catch(console.error));
});

async function handleLineEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') return;

  const text       = event.message.text.trim();
  const userId     = event.source.userId;
  const replyToken = event.replyToken;

  // ── 「受付 123」で紐付け ──
  const match = text.match(/^受付\s*(\d+)$/);
  if (match) {
    const id = parseInt(match[1], 10);
    const t  = Q.get.get(id);

    if (!t) {
      return replyMsg(replyToken, `受付番号 ${id} は見つからんかったで。番号を確認してや〜`);
    }
    if (t.status === 'done') {
      return replyMsg(replyToken, `受付番号 ${id} はもう完了しちゅうで！`);
    }
    if (t.line_user_id) {
      return replyMsg(replyToken, `受付番号 ${id} はもうLINE登録済みやき！順番が来たらお知らせするき待っちょってや〜`);
    }

    Q.linkLine.run(userId, id);
    const pos = Q.position.get(id).p + 1;
    return replyMsg(replyToken,
      `受付番号 ${id}（${t.name}さん）にLINE通知を紐付けたで！\n現在 ${pos}番目やき、順番が来たらここにお知らせするき待っちょってや〜`
    );
  }

  // ── 「状況」「確認」で自分の順番確認 ──
  if (text === '状況' || text === '確認') {
    const t = Q.byLineUsr.get(userId);
    if (!t) {
      return replyMsg(replyToken, '受付がまだやき！\nお店で受付して「受付 番号」と送ってや〜');
    }
    if (t.status === 'called') {
      return replyMsg(replyToken, `受付番号 ${t.id} は呼出中やき！はよ来てや〜！`);
    }
    const pos = Q.position.get(t.id).p + 1;
    return replyMsg(replyToken, `受付番号 ${t.id}：現在 ${pos}番目やき。もうちょっと待っちょってや〜`);
  }

  // ── ヘルプ ──
  return replyMsg(replyToken,
    `${STORE_NAME} 順番待ちシステムやき！\n\n` +
    `お店で受付した後、表示される番号を使って\n「受付 123」\nと送ってや〜。LINE通知が届くようになるき！\n\n` +
    `「状況」と送ると順番を確認できるで〜`
  );
}

// ══════════════════════════════════════════
//  サーバー起動
// ══════════════════════════════════════════
app.listen(PORT, () => {
  console.log(`=== ${STORE_NAME} 順番待ちシステム v4 ===`);
  console.log(`PORT      : ${PORT}`);
  console.log(`BASE_URL  : ${BASE_URL || '(自動検出)'}`);
  console.log(`LINE SDK  : ${lineClient ? 'OK' : '未設定'}`);
  console.log(`Routes    : / /form /status /admin /admin/qr /webhook`);
  console.log('==========================================');
});
