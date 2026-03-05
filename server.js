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
const LINE_ADD_FRIEND_URL = process.env.LINE_ADD_FRIEND_URL || '';
const LINE_OFFICIAL_ID    = process.env.LINE_OFFICIAL_ID || '';  // 例: @abcd1234
const ADMIN_USER_ID       = process.env.ADMIN_USER_ID || '';
const ENABLE_CUSTOMER_PUSH = process.env.ENABLE_CUSTOMER_PUSH === 'true'; // デフォルト false

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
  if (!lineClient) { console.log('[LINE push] lineClient未初期化'); return; }
  if (!userId) { console.log('[LINE push] userId未指定'); return; }
  const m = [{ type: 'text', text }];
  try {
    sdkNew
      ? await lineClient.pushMessage({ to: userId, messages: m })
      : await lineClient.pushMessage(userId, m);
    console.log('[LINE push OK] to=' + userId.substring(0, 8) + '...');
  } catch (e) {
    console.error('[LINE push ERROR]', {
      statusCode: e.statusCode || e.status || '?',
      message: e.message,
      data: e.body || e.originalError?.response?.data || ''
    });
  }
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
  link_token  TEXT DEFAULT '',
  created_at  TEXT DEFAULT (datetime('now','localtime'))
)`);
// 既存DBへの互換対応
try { db.exec("ALTER TABLE tickets ADD COLUMN link_token TEXT DEFAULT ''"); } catch (_) {}
try { db.exec("ALTER TABLE tickets ADD COLUMN called_at TEXT DEFAULT ''"); } catch (_) {}

// ── タスク管理テーブル ──
db.exec(`CREATE TABLE IF NOT EXISTS tasks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL,
  due_date    TEXT,
  due_time    TEXT DEFAULT '',
  priority    TEXT DEFAULT 'normal',
  category    TEXT DEFAULT 'general',
  status      TEXT DEFAULT 'pending',
  memo        TEXT DEFAULT '',
  created_at  TEXT DEFAULT (datetime('now','localtime'))
)`);

const TQ = {
  insert:    db.prepare('INSERT INTO tasks (title, due_date, due_time, priority, category, memo) VALUES (?, ?, ?, ?, ?, ?)'),
  all:       db.prepare('SELECT * FROM tasks ORDER BY CASE status WHEN "pending" THEN 0 WHEN "done" THEN 1 END, due_date ASC, due_time ASC, id ASC'),
  today:     db.prepare("SELECT * FROM tasks WHERE status = 'pending' AND due_date <= date('now','localtime') ORDER BY due_time ASC, priority DESC"),
  pending:   db.prepare("SELECT * FROM tasks WHERE status = 'pending' ORDER BY due_date ASC, due_time ASC"),
  setDone:   db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?"),
  setPending:db.prepare("UPDATE tasks SET status = 'pending' WHERE id = ?"),
  del:       db.prepare('DELETE FROM tasks WHERE id = ?'),
  get:       db.prepare('SELECT * FROM tasks WHERE id = ?'),
};

const Q = {
  insert:    db.prepare('INSERT INTO tickets (name, phone, people, link_token) VALUES (?, ?, ?, ?)'),
  get:       db.prepare('SELECT * FROM tickets WHERE id = ?'),
  setStatus:  db.prepare('UPDATE tickets SET status = ? WHERE id = ?'),
  setCalled:  db.prepare("UPDATE tickets SET status = 'called', called_at = ? WHERE id = ?"),
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

  // linkToken: ランダム16文字 hex（先頭8文字を tokenShort として使う）
  const linkToken = crypto.randomBytes(8).toString('hex');
  const tokenShort = linkToken.substring(0, 8);

  const info = Q.insert.run(name, phone, people, linkToken);
  const id   = Number(info.lastInsertRowid);
  const pos  = Q.cntWait.get().c;

  // ── 管理者へ push 通知（常に送る） ──
  if (ADMIN_USER_ID) {
    const adminBase = BASE_URL || '(BASE_URL未設定)';
    pushMsg(ADMIN_USER_ID,
      `【新規受付】No:${id}\n名前：${name}\n人数：${people}\n電話：${phone || 'なし'}\n管理画面：${adminBase}/admin`
    ).catch(() => {});
  }

  // ── LINE連携セクション（ENABLE_CUSTOMER_PUSH で切替） ──
  let lineSection = '';
  if (ENABLE_CUSTOMER_PUSH) {
    const linkMsg = `連携 ${id} ${tokenShort}`;
    const oaId = LINE_OFFICIAL_ID.replace(/^@/, '');
    const oaMessageUrl = oaId
      ? `https://line.me/R/oaMessage/${encodeURIComponent('@' + oaId)}/?${encodeURIComponent(linkMsg)}`
      : '';
    const addFriendBtn = LINE_ADD_FRIEND_URL
      ? `<a href="${LINE_ADD_FRIEND_URL}" class="lbtn lbtn-add" target="_blank">1. 友だち追加する</a>`
      : `<p style="color:#666;font-size:.9em">1. LINE公式アカウント <b>${LINE_OFFICIAL_ID || '(未設定)'}</b> を友だち追加</p>`;
    const linkBtn = oaMessageUrl
      ? `<a href="${oaMessageUrl}" class="lbtn lbtn-link">2. LINE通知を連携する</a>
         <p style="color:#888;font-size:.75em;margin-top:4px">タップ → LINEが開く → 送信ボタンを押すだけ！</p>`
      : `<p style="color:#666;font-size:.9em">2. LINEで <b>「${linkMsg}」</b> と送信</p>`;
    lineSection = `
    <div style="background:#e8f5e9;border:2px solid #a5d6a7;border-radius:12px;padding:20px;margin-top:20px;text-align:center">
      <p style="font-weight:bold;color:#2e7d32;margin-bottom:14px;font-size:1em">LINE通知を受け取る（入力なし・ボタンだけ！）</p>
      ${addFriendBtn}
      <div style="margin-top:12px">${linkBtn}</div>
      <p style="color:#999;font-size:.7em;margin-top:12px">順番が来たらLINEでお知らせするき！</p>
    </div>`;
  } else {
    lineSection = `<p style="color:#888;font-size:.9em;margin-top:20px;line-height:1.6">お店の近くでお待ちください。<br>順番が来たらお呼びします。</p>`;
  }

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
  ${lineSection}
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
</script>`,
`.lbtn{display:block;width:100%;padding:14px;border-radius:10px;font-size:1em;font-weight:bold;text-align:center;text-decoration:none;color:#fff}
.lbtn-add{background:#06c755}
.lbtn-add:active{background:#05a648}
.lbtn-link{background:#4a90d9}
.lbtn-link:active{background:#3a7bc0}`));
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

  const WAIT_TH = '<tr><th>No</th><th>名前</th><th>電話</th><th>人数</th><th>時刻</th><th>LINE</th><th>操作</th></tr>';
  const CALL_TH = '<tr><th>No</th><th>名前</th><th>電話</th><th>人数</th><th>残り</th><th>操作</th></tr>';

  function waitRow(t) {
    const ln = t.line_user_id ? '✅' : '-';
    const tm = t.created_at ? t.created_at.substring(11, 16) : '';
    const btns = `<button class="btn bg sm" onclick="act('call',${t.id})">呼び出し</button> <button class="btn br sm" onclick="act('delete',${t.id})">削除</button>`;
    return `<tr><td><b>#${t.id}</b></td><td>${t.name}</td><td>${t.phone||'-'}</td><td>${t.people}名</td><td>${tm}</td><td>${ln}</td><td>${btns}</td></tr>`;
  }

  function callRow(t) {
    const ca = t.called_at || '';
    const btns = `<button class="btn bo sm" onclick="act('recall',${t.id})">再呼出</button> <button class="btn bo sm" onclick="act('done',${t.id})">完了</button> <button class="btn bg2 sm" onclick="act('requeue',${t.id})">戻す</button>`;
    const skipBtn = `<button class="btn br sm skip-btn" onclick="act('skip',${t.id})" style="display:none" data-skip-id="${t.id}">飛ばす</button>`;
    return `<tr data-called-at="${ca}" data-id="${t.id}"><td><b>#${t.id}</b></td><td>${t.name}</td><td>${t.phone||'-'}</td><td>${t.people}名</td><td class="timer-cell">--:--</td><td>${btns} ${skipBtn}</td></tr>`;
  }

  const waitRows = waiting.map(t => waitRow(t)).join('');
  const callRows = called.map(t => callRow(t)).join('');

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

  ${called.length ? `<h2 class="sh" style="color:#ff9800">呼び出し中</h2><div class="tw"><table>${CALL_TH}${callRows}</table></div><hr style="margin:16px 0;border:none;border-top:1px solid #eee">` : ''}

  <h2 class="sh">待ち一覧（${waiting.length}組）</h2>
  ${waiting.length
    ? `<div class="tw"><table>${WAIT_TH}${waitRows}</table></div>`
    : '<p style="color:#aaa;text-align:center;padding:16px">待ちなし</p>'}
</div>
<div style="text-align:center;margin-top:8px">
  <a href="/admin/qr" class="btn bg" style="margin-right:6px">QR表示</a>
  <a href="/status" class="btn bg2">待ち状況</a>
</div>
<script>
async function act(a,id){
  if(a==='delete'&&!confirm('削除しますか？'))return;
  if(a==='skip'&&!confirm('飛ばしますか？'))return;
  var route=a==='recall'?'call':a;
  var r=await fetch('/'+route+'/'+id,{method:'POST'});
  var d=await r.json();
  if((a==='call'||a==='recall')&&d.success)alert('呼び出しました');
  location.reload();
}
var LIMIT=7*60*1000;
function tick(){
  document.querySelectorAll('[data-called-at]').forEach(function(tr){
    var ca=tr.getAttribute('data-called-at');
    if(!ca)return;
    var elapsed=Date.now()-new Date(ca).getTime();
    var remain=LIMIT-elapsed;
    var cell=tr.querySelector('.timer-cell');
    var sid=tr.getAttribute('data-id');
    var skipBtn=tr.querySelector('.skip-btn');
    if(remain<=0){
      cell.textContent='時間切れ';
      cell.style.color='#e53935';
      cell.style.fontWeight='bold';
      tr.style.background='#fbe9e7';
      if(skipBtn)skipBtn.style.display='inline-block';
    }else{
      var m=Math.floor(remain/60000);
      var s=Math.floor((remain%60000)/1000);
      cell.textContent=(m<10?'0':'')+m+':'+(s<10?'0':'')+s;
      if(remain<120000){cell.style.color='#e53935';cell.style.fontWeight='bold';}
      else if(remain<240000){cell.style.color='#ff9800';}
      else{cell.style.color='#333';}
    }
  });
}
tick();setInterval(tick,1000);
setTimeout(function(){location.reload()},60000);
</script>`,
`.sh{font-size:1em;color:#333;margin-bottom:8px}
.tw{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:.82em}
th{background:#f8f9fa;padding:7px 5px;text-align:left;font-size:.78em;color:#666;white-space:nowrap}
td{padding:7px 5px;border-bottom:1px solid #f0f0f0;white-space:nowrap}
.sm{padding:3px 8px;font-size:.75em;margin:1px}
.timer-cell{font-family:monospace;font-size:1.1em;min-width:56px}`));
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
  if (!t) return res.status(404).json({ success: false, message: '受付番号が見つかりません' });
  if (t.status !== 'waiting' && t.status !== 'called') return res.status(400).json({ success: false, message: `状態が ${t.status} です` });

  const now = new Date().toISOString();
  Q.setCalled.run(now, id);

  const callMsg = `大正町市場やき！\n${id}番のお客さん、順番きたで〜！\n7分以内に戻ってきてや。\n来んかったら次に回すきね。`;

  // 管理者へLINE通知
  if (ADMIN_USER_ID) {
    await pushMsg(ADMIN_USER_ID, callMsg);
  }

  if (ENABLE_CUSTOMER_PUSH && t.line_user_id) {
    await pushMsg(t.line_user_id, callMsg);
  }
  res.json({ success: true });
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
//  POST /skip/:id ── 飛ばし（時間切れ・来店なし）
// ══════════════════════════════════════════
app.post('/skip/:id', (_req, res) => {
  const id = parseInt(_req.params.id, 10);
  const t  = Q.get.get(id);
  if (!t) return res.status(404).json({ success: false, message: '見つかりません' });
  Q.setStatus.run('skipped', id);
  res.json({ success: true, message: `${t.name}さんを飛ばしました` });
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
  // ── 全イベントで userId をログ出力（ADMIN_USER_ID 特定用） ──
  console.log('[LINE] userId=', event.source?.userId);

  if (event.type !== 'message' || event.message.type !== 'text') return;

  const text       = event.message.text.trim();
  const userId     = event.source.userId;
  const replyToken = event.replyToken;

  // ── 連携コマンド（ENABLE_CUSTOMER_PUSH=false なら無効） ──
  const linkMatch = text.match(/^連携\s+(\d+)\s+([a-f0-9]+)$/i);
  const legacyMatch = !linkMatch && text.match(/^受付\s*(\d+)$/);
  if ((linkMatch || legacyMatch) && !ENABLE_CUSTOMER_PUSH) {
    return replyMsg(replyToken, `現在LINE連携は準備中やき。お店でお待ちくださいね〜`);
  }

  // ── 「連携 {id} {tokenShort}」でトークン検証付き紐付け（oaMessageボタン用） ──
  if (linkMatch) {
    const id = parseInt(linkMatch[1], 10);
    const tokenInput = linkMatch[2].toLowerCase();
    const t = Q.get.get(id);

    if (!t) {
      return replyMsg(replyToken, `受付番号 ${id} は見つからんかったで。番号を確認してや〜`);
    }
    if (t.status === 'done') {
      return replyMsg(replyToken, `受付番号 ${id} はもう完了しちゅうで！`);
    }
    if (t.line_user_id) {
      return replyMsg(replyToken, `受付番号 ${id} はもうLINE連携済みやき！順番が来たらお知らせするき待っちょってや〜`);
    }
    // linkToken の先頭が一致するか検証
    if (!t.link_token || !t.link_token.startsWith(tokenInput)) {
      return replyMsg(replyToken, `連携コードが合わんかったで。受付画面のボタンからもう一回やってみてや〜`);
    }

    Q.linkLine.run(userId, id);
    const pos = Q.position.get(id).p + 1;

    // 管理者にも通知
    if (ADMIN_USER_ID) {
      pushMsg(ADMIN_USER_ID, `🔗 No:${id}（${t.name}さん）がLINE連携完了`).catch(() => {});
    }

    return replyMsg(replyToken,
      `連携完了やき！受付番号 ${id}（${t.name}さん）\n現在 ${pos}番目。順番が近づいたら通知するきね〜`
    );
  }

  // ── 「受付 123」で紐付け（手入力フォールバック） ──
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

    if (ADMIN_USER_ID) {
      pushMsg(ADMIN_USER_ID, `🔗 No:${id}（${t.name}さん）がLINE連携完了`).catch(() => {});
    }

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
//  GET /tasks ── タスク管理画面
// ══════════════════════════════════════════
app.get('/tasks', (_req, res) => {
  const all = TQ.all.all();
  const today = new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD

  const PRIORITY_LABEL = { high: '🔴 急', normal: '🟡 普通', low: '🔵 後で' };
  const CATEGORY_LABEL = {
    general: '一般', tax: '確定申告', travel: '旅行', presentation: 'プレゼン',
    delivery: '発送', admin: '事務', market: '市場', business: '事業'
  };

  function taskRow(t) {
    const isDone = t.status === 'done';
    const isOverdue = !isDone && t.due_date && t.due_date < today;
    const isToday = !isDone && t.due_date === today;
    const dueStr = t.due_date ? `${t.due_date}${t.due_time ? ' ' + t.due_time : ''}` : '期限なし';
    const prLabel = PRIORITY_LABEL[t.priority] || t.priority;
    const catLabel = CATEGORY_LABEL[t.category] || t.category;

    let rowStyle = 'background:#fff';
    if (isDone) rowStyle = 'background:#f5f5f5;opacity:.6';
    else if (isOverdue) rowStyle = 'background:#fbe9e7';
    else if (isToday) rowStyle = 'background:#e8f5e9';

    const checkBtn = isDone
      ? `<button class="btn bg2 sm" onclick="taskAct('reopen',${t.id})">戻す</button>`
      : `<button class="btn bg sm" onclick="taskAct('done',${t.id})">✓ 完了</button>`;

    const badge = isOverdue ? '<span style="color:#e53935;font-size:.75em;font-weight:bold"> ⚠期限超過</span>'
                : isToday   ? '<span style="color:#2e7d32;font-size:.75em;font-weight:bold"> 📅今日</span>'
                : '';

    return `<tr style="${rowStyle}">
      <td style="font-size:.9em">${isDone ? '<s>' : ''}${t.title}${isDone ? '</s>' : ''}${badge}</td>
      <td style="font-size:.8em;white-space:nowrap">${dueStr}</td>
      <td style="font-size:.75em">${prLabel}</td>
      <td style="font-size:.75em">${catLabel}</td>
      <td style="font-size:.75em;color:#888">${(t.memo||'').substring(0,20)}</td>
      <td>${checkBtn} <button class="btn br sm" onclick="taskAct('delete',${t.id})">削除</button></td>
    </tr>`;
  }

  const pending = all.filter(t => t.status === 'pending');
  const done    = all.filter(t => t.status === 'done');
  const todayTasks = pending.filter(t => t.due_date && t.due_date <= today);

  res.send(layout('タスク管理', `
<div class="card">
  <h1 style="color:#06c755;font-size:1.2em;margin-bottom:4px">📋 タスク管理</h1>
  <p style="color:#888;font-size:.8em;margin-bottom:14px">今日: ${today}</p>

  <div style="display:flex;gap:8px;margin-bottom:16px">
    <div style="flex:1;text-align:center;background:#fbe9e7;padding:10px;border-radius:8px">
      <div style="font-size:1.8em;font-weight:bold;color:#e53935">${todayTasks.length}</div>
      <div style="font-size:.75em;color:#666">今日以前</div>
    </div>
    <div style="flex:1;text-align:center;background:#fff8e1;padding:10px;border-radius:8px">
      <div style="font-size:1.8em;font-weight:bold;color:#ff9800">${pending.length}</div>
      <div style="font-size:.75em;color:#666">未完了</div>
    </div>
    <div style="flex:1;text-align:center;background:#e8f5e9;padding:10px;border-radius:8px">
      <div style="font-size:1.8em;font-weight:bold;color:#06c755">${done.length}</div>
      <div style="font-size:.75em;color:#666">完了済み</div>
    </div>
  </div>

  <h2 style="font-size:.95em;color:#333;margin-bottom:10px">＋ 新しいタスクを追加</h2>
  <form method="POST" action="/tasks" style="background:#f8f9fa;padding:12px;border-radius:10px">
    <input type="text" name="title" required placeholder="タスク名（例：確定申告を提出）" style="width:100%;padding:10px;border:2px solid #ddd;border-radius:8px;font-size:.95em;margin-bottom:8px">
    <div style="display:flex;gap:6px;margin-bottom:8px;flex-wrap:wrap">
      <input type="date" name="due_date" style="flex:1;min-width:120px;padding:8px;border:2px solid #ddd;border-radius:8px;font-size:.9em">
      <input type="time" name="due_time" style="flex:1;min-width:100px;padding:8px;border:2px solid #ddd;border-radius:8px;font-size:.9em">
    </div>
    <div style="display:flex;gap:6px;margin-bottom:8px;flex-wrap:wrap">
      <select name="priority" style="flex:1;padding:8px;border:2px solid #ddd;border-radius:8px;font-size:.9em">
        <option value="high">🔴 急ぎ</option>
        <option value="normal" selected>🟡 普通</option>
        <option value="low">🔵 後で</option>
      </select>
      <select name="category" style="flex:1;padding:8px;border:2px solid #ddd;border-radius:8px;font-size:.9em">
        <option value="general">一般</option>
        <option value="tax">確定申告</option>
        <option value="travel">旅行</option>
        <option value="presentation">プレゼン</option>
        <option value="delivery">発送</option>
        <option value="admin">事務</option>
        <option value="market">市場</option>
        <option value="business">事業</option>
      </select>
    </div>
    <input type="text" name="memo" placeholder="メモ（任意）" style="width:100%;padding:8px;border:2px solid #ddd;border-radius:8px;font-size:.9em;margin-bottom:8px">
    <button type="submit" class="btn bg" style="width:100%;padding:10px;font-size:.95em">追加する</button>
  </form>
</div>

<div class="card">
  <h2 style="font-size:.95em;color:#333;margin-bottom:10px">未完了タスク（${pending.length}件）</h2>
  ${pending.length ? `<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:.85em">
    <tr style="background:#f8f9fa"><th style="padding:6px 4px;text-align:left">タスク</th><th>期限</th><th>優先</th><th>カテゴリ</th><th>メモ</th><th>操作</th></tr>
    ${pending.map(t => taskRow(t)).join('')}
  </table></div>` : '<p style="color:#aaa;text-align:center;padding:16px">未完了タスクなし 🎉</p>'}
</div>

${done.length ? `<div class="card">
  <h2 style="font-size:.95em;color:#888;margin-bottom:10px">完了済み（${done.length}件）</h2>
  <div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:.85em">
    <tr style="background:#f8f9fa"><th style="padding:6px 4px;text-align:left">タスク</th><th>期限</th><th>優先</th><th>カテゴリ</th><th>メモ</th><th>操作</th></tr>
    ${done.map(t => taskRow(t)).join('')}
  </table></div>
</div>` : ''}

<script>
async function taskAct(a, id) {
  if (a === 'delete' && !confirm('削除しますか？')) return;
  await fetch('/tasks/' + id + '/' + a, { method: 'POST' });
  location.reload();
}
</script>`,
`th{background:#f8f9fa;padding:7px 4px;text-align:left;font-size:.78em;color:#666;white-space:nowrap}
td{padding:7px 4px;border-bottom:1px solid #f0f0f0}
.sm{padding:3px 8px;font-size:.75em;margin:1px}`));
});

// ══════════════════════════════════════════
//  POST /tasks ── タスク追加
// ══════════════════════════════════════════
app.post('/tasks', (req, res) => {
  const title    = (req.body.title || '').trim().substring(0, 100);
  const due_date = (req.body.due_date || '').trim();
  const due_time = (req.body.due_time || '').trim();
  const priority = ['high', 'normal', 'low'].includes(req.body.priority) ? req.body.priority : 'normal';
  const category = (req.body.category || 'general').trim();
  const memo     = (req.body.memo || '').trim().substring(0, 200);
  if (!title) return res.redirect('/tasks');
  TQ.insert.run(title, due_date || null, due_time, priority, category, memo);
  res.redirect('/tasks');
});

// ══════════════════════════════════════════
//  POST /tasks/:id/done|reopen|delete
// ══════════════════════════════════════════
app.post('/tasks/:id/done', (req, res) => {
  TQ.setDone.run(parseInt(req.params.id, 10));
  res.json({ ok: true });
});
app.post('/tasks/:id/reopen', (req, res) => {
  TQ.setPending.run(parseInt(req.params.id, 10));
  res.json({ ok: true });
});
app.post('/tasks/:id/delete', (req, res) => {
  TQ.del.run(parseInt(req.params.id, 10));
  res.json({ ok: true });
});

// ══════════════════════════════════════════
//  GET /api/tasks/today ── 今日のタスクAPI
// ══════════════════════════════════════════
app.get('/api/tasks/today', (_req, res) => {
  res.json(TQ.today.all());
});

// ══════════════════════════════════════════
//  毎朝8時 LINE タスクブリーフィング
// ══════════════════════════════════════════
function buildDailyBriefing() {
  const tasks = TQ.today.all();
  if (!tasks.length) return null;
  const PRIORITY_MARK = { high: '🔴', normal: '🟡', low: '🔵' };
  const lines = tasks.map((t, i) => {
    const time = t.due_time ? ` ${t.due_time}` : '';
    const p = PRIORITY_MARK[t.priority] || '・';
    return `${p} ${t.title}${time}`;
  });
  return `🌅 おはようございます、梶永さん！\n今日のタスク（${tasks.length}件）\n\n${lines.join('\n')}\n\n今日も一つずつ進めましょう 💪`;
}

let lastBriefingDate = '';
setInterval(() => {
  if (!ADMIN_USER_ID) return;
  const now = new Date();
  const hhmm = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
  const today = now.toLocaleDateString('sv-SE');
  if (hhmm === '08:00' && lastBriefingDate !== today) {
    lastBriefingDate = today;
    const msg = buildDailyBriefing();
    if (msg) pushMsg(ADMIN_USER_ID, msg).catch(console.error);
  }
}, 30000); // 30秒ごとにチェック

// ══════════════════════════════════════════
//  サーバー起動
// ══════════════════════════════════════════
// ── 初期タスクのシード（初回起動時のみ） ──
(function seedInitialTasks() {
  const existing = TQ.all.all();
  if (existing.length > 0) return; // すでにデータがあればスキップ
  const initialTasks = [
    { title: '確定申告を提出する', due_date: '2026-03-06', due_time: '', priority: 'high', category: 'tax', memo: '今日か明日中に必ず' },
    { title: '出張届けを提出する', due_date: '2026-03-06', due_time: '', priority: 'high', category: 'admin', memo: '明日中' },
    { title: 'くろしお切符参加店の名簿を作成して谷口さんに送信', due_date: '2026-03-06', due_time: '', priority: 'high', category: 'market', memo: '明日早々に' },
    { title: '祈り米🌾を発送する', due_date: '2026-03-08', due_time: '', priority: 'high', category: 'delivery', memo: '今週中に' },
    { title: '壱岐旅行の荷造りをする', due_date: '2026-03-10', due_time: '', priority: 'normal', category: 'travel', memo: '来週火曜出発前に' },
    { title: '鰹エラスチンプロジェクトのプレゼン資料を準備', due_date: '2026-03-16', due_time: '09:00', priority: 'high', category: 'presentation', memo: '役場・9時から' },
  ];
  for (const t of initialTasks) {
    TQ.insert.run(t.title, t.due_date, t.due_time, t.priority, t.category, t.memo);
  }
  console.log('[Tasks] 初期タスク6件を登録しました');
})();

app.listen(PORT, () => {
  console.log(`=== ${STORE_NAME} 順番待ちシステム v5 ===`);
  console.log(`PORT             : ${PORT}`);
  console.log(`BASE_URL         : ${BASE_URL || '(自動検出)'}`);
  console.log(`LINE SDK         : ${lineClient ? 'OK' : '未設定'}`);
  console.log(`ADMIN_USER_ID    : ${ADMIN_USER_ID ? ADMIN_USER_ID.substring(0, 8) + '...' : '未設定'}`);
  console.log(`CUSTOMER_PUSH    : ${ENABLE_CUSTOMER_PUSH ? 'ON' : 'OFF'}`);
  console.log(`Routes           : / /form /status /admin /admin/qr /tasks /webhook`);
  console.log('==========================================');
});
