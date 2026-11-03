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
// お客さんへのLINE通知：デフォルト ON。止めたい時だけ ENABLE_CUSTOMER_PUSH=false
const ENABLE_CUSTOMER_PUSH = process.env.ENABLE_CUSTOMER_PUSH !== 'false';

// 呼び出し後の猶予（7分）
const CALL_LIMIT_MS = 7 * 60 * 1000;

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

// 公式アカウントID（@なし）と、友だち追加URL
const OA_ID = LINE_OFFICIAL_ID.replace(/^@/, '').trim();
const ADD_FRIEND_URL = LINE_ADD_FRIEND_URL
  || (OA_ID ? `https://line.me/R/ti/p/${encodeURIComponent('@' + OA_ID)}` : '');
// 受付後の画面に「LINEでも通知を受け取る」を出せるか
const CUSTOMER_LINE_READY = ENABLE_CUSTOMER_PUSH && !!lineClient && !!(OA_ID || ADD_FRIEND_URL);

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

// 呼び出しの文面（LINE・受付後の画面で共通）
function callMessage(id) {
  return `大正町市場やき！\n${id}番のお客さん、順番きたで〜！\n7分以内に戻ってきてや。\n来んかったら次に回すきね。`;
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

// HTML に入れる文字のエスケープ（名前などに < > が入っても画面が壊れんように）
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// 受付ページの合言葉（link_token）の照合
function tokenOk(input, token) {
  if (!token || typeof input !== 'string' || input.length !== token.length) return false;
  return crypto.timingSafeEqual(Buffer.from(input), Buffer.from(token));
}

// ══════════════════════════════════════════
//  時刻ユーティリティ
// ══════════════════════════════════════════
// created_at は SQLite の datetime('now','localtime') で
// 「YYYY-MM-DD HH:MM:SS」（サーバーのローカル時刻・タイムゾーン表記なし）で保存されている。
// Node の Date はタイムゾーン表記なしの日時をサーバーのローカル時刻として解釈するので、
// 同じサーバー上で解釈すれば正しい絶対時刻（ミリ秒）になる。
function parseCreatedAt(s) {
  if (!s) return 0;
  const str = String(s).trim();
  const hasZone = /([zZ]|[+-]\d{2}:?\d{2})$/.test(str);
  const ms = hasZone ? Date.parse(str) : new Date(str.replace(' ', 'T')).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

// 経過時間を「3分」「1時間5分」の形に
function formatElapsed(ms) {
  if (!(ms >= 60000)) return '1分未満';
  const min = Math.floor(ms / 60000);
  if (min < 60) return min + '分';
  return Math.floor(min / 60) + '時間' + (min % 60) + '分';
}

// 日本時間（Asia/Tokyo）の「HH:MM」
const JST_FMT = new Intl.DateTimeFormat('ja-JP', {
  timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', hour12: false
});
function formatJstTime(ms) {
  return JST_FMT.format(new Date(ms));
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

  // linkToken: ランダム16文字 hex（受付ページの合言葉。先頭8文字をLINE連携コードに使う）
  const linkToken = crypto.randomBytes(8).toString('hex');

  const info = Q.insert.run(name, phone, people, linkToken);
  const id   = Number(info.lastInsertRowid);

  // ── 管理者へ push 通知（常に送る） ──
  if (ADMIN_USER_ID) {
    const adminBase = BASE_URL || '(BASE_URL未設定)';
    pushMsg(ADMIN_USER_ID,
      `【新規受付】No:${id}\n名前：${name}\n人数：${people}\n電話：${phone || 'なし'}\n管理画面：${adminBase}/admin`
    ).catch(() => {});
  }

  // 受付後の画面へ移動（再読み込みしても二重受付にならず、閉じても開き直せる）
  res.redirect(303, `/ticket/${id}?k=${linkToken}`);
});

// ══════════════════════════════════════════
//  GET /ticket/:id ── 受付後の画面（呼び出しを待つ画面）
// ══════════════════════════════════════════
app.get('/ticket/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const t  = Number.isFinite(id) ? Q.get.get(id) : null;
  if (!t || !tokenOk(String(req.query.k || ''), t.link_token)) {
    return res.status(404).send(layout('受付が見つかりません', `
<div class="card" style="text-align:center">
  <h1 style="color:#888;font-size:1.2em;margin-bottom:10px">受付が見つからんかったで</h1>
  <p style="color:#666;line-height:1.7">お手数やけど、お店の人に声をかけてや〜</p>
  <a href="/form" class="btn bg" style="margin-top:16px">受付画面へ</a>
</div>`));
  }

  const pos = t.status === 'waiting' ? Q.position.get(id).p + 1 : 0;
  const tokenShort = t.link_token.substring(0, 8);
  const callHtml = callMessage(id).split('\n').map(esc).join('<br>');

  // ── LINE連携セクション ──
  let lineSection = '';
  if (CUSTOMER_LINE_READY) {
    const linkMsg = `連携 ${id} ${tokenShort}`;
    const oaMessageUrl = OA_ID
      ? `https://line.me/R/oaMessage/${encodeURIComponent('@' + OA_ID)}/?${encodeURIComponent(linkMsg)}`
      : '';
    const step1 = ADD_FRIEND_URL
      ? `<a href="${esc(ADD_FRIEND_URL)}" class="lbtn lbtn-add" target="_blank" rel="noopener">① 友だち追加する</a>`
      : '';
    const step2 = oaMessageUrl
      ? `<a href="${esc(oaMessageUrl)}" class="lbtn lbtn-link">② 連携メッセージを送る</a>
         <p class="lnote">LINEが開いたら、そのまま送信ボタンを押すだけ！</p>`
      : `<p class="lnote" style="font-size:.95em;color:#333">② LINEで <b>「${esc(linkMsg)}」</b> と送信してね</p>`;
    lineSection = `
<div class="card" id="line-box" style="text-align:center">
  <div id="line-off">
    <button type="button" class="lbtn lbtn-main" onclick="document.getElementById('line-steps').style.display='block';this.style.display='none'">LINEでも通知を受け取る</button>
    <div id="line-steps" style="display:none">
      <p style="font-weight:bold;color:#2e7d32;margin-bottom:12px">LINEでも通知を受け取る</p>
      ${step1}
      <div style="margin-top:10px">${step2}</div>
      <p class="lnote">友だち追加したら、この画面に戻って②を押してや〜</p>
    </div>
  </div>
  <div id="line-on" style="display:none;color:#2e7d32;font-weight:bold;line-height:1.7">
    ✅ LINEとつながったで！<br><span style="font-weight:normal;color:#555;font-size:.9em">呼ばれたらLINEにもお知らせするき。</span>
  </div>
</div>`;
  }

  const init = {
    status: t.status,
    position: pos,
    called_at: t.called_at || '',
    linked: !!t.line_user_id,
  };

  res.send(layout(`受付番号 ${id}｜${STORE_NAME}`, `
<div id="call-screen" class="card call-card" style="display:none">
  <div class="call-icon">📣</div>
  <div class="call-msg">${callHtml}</div>
  <div class="call-timer-label" id="call-timer-label">残り時間</div>
  <div class="call-timer" id="call-timer">07:00</div>
  <button type="button" class="ack-btn" id="ack-btn" onclick="ack()">わかった！（音を止める）</button>
</div>

<div class="card" style="text-align:center">
  <h1 style="color:#06c755" id="head">受付できたで！</h1>
  <p style="font-size:1.05em;color:#333;margin-top:12px">${esc(t.name)}さん（${t.people}名）</p>
  <div style="margin:20px 0">
    <p style="color:#666;font-size:.85em">受付番号</p>
    <div style="font-size:3.5em;font-weight:bold;color:#06c755">${id}</div>
  </div>
  <div id="pa">
    <p style="color:#666;font-size:.85em">現在の順番</p>
    <div style="font-size:2em;font-weight:bold"><span id="pos">${pos || '-'}</span><small style="color:#666"> 番目</small></div>
  </div>
  <div id="end-area" style="display:none;color:#555;line-height:1.7;padding:12px 0"></div>
  <p id="wait-note" style="color:#888;font-size:.9em;margin-top:16px;line-height:1.6">お店の近くでお待ちください。<br>順番が来たら<b>この画面が切り替わって</b>お知らせするき！<br><span style="font-size:.9em">この画面は閉じんと開いたままにしちょってね。</span></p>
  <p style="color:#aaa;font-size:.75em;margin-top:14px" id="upd">10秒ごとに自動更新中...</p>
</div>

<div class="card" id="alert-box" style="text-align:center">
  <button type="button" class="lbtn lbtn-alert" id="alert-btn" onclick="enableAlert()">🔔 音とバイブでお知らせを受け取る</button>
  <p class="lnote" id="alert-note">タップしちょくと、呼ばれた時に音（とバイブ）でお知らせするき。<br>マナーモードやと音は鳴らんことがあるき注意してね。</p>
</div>

${lineSection}

<script>
(function(){
  var ID=${id};
  var LIMIT=${CALL_LIMIT_MS};
  var OFFSET=${Date.now()}-Date.now();
  var state=${JSON.stringify(init)};
  var lastCalledAt='';
  var calledAtMs=0;
  var acked=false;
  var alarmTimer=null;
  var audioCtx=null;
  var wakeLock=null;
  var stopped=false;
  var baseTitle=document.title;
  var $=function(id){return document.getElementById(id)};

  // ── 音（Web Audio）──
  function unlockAudio(){
    try{
      if(!audioCtx){
        var AC=window.AudioContext||window.webkitAudioContext;
        if(AC)audioCtx=new AC();
      }
      if(audioCtx&&audioCtx.state==='suspended')audioCtx.resume();
    }catch(e){}
  }
  function beep(times){
    if(!audioCtx)return;
    try{
      var t0=audioCtx.currentTime+0.05;
      for(var i=0;i<times;i++){
        var o=audioCtx.createOscillator(),g=audioCtx.createGain();
        o.type='square';o.frequency.value=(i%2)?1175:880;
        g.gain.setValueAtTime(0.0001,t0+i*0.35);
        g.gain.exponentialRampToValueAtTime(0.4,t0+i*0.35+0.02);
        g.gain.exponentialRampToValueAtTime(0.0001,t0+i*0.35+0.28);
        o.connect(g);g.connect(audioCtx.destination);
        o.start(t0+i*0.35);o.stop(t0+i*0.35+0.3);
      }
    }catch(e){}
  }
  function vibrate(p){try{if(navigator.vibrate)navigator.vibrate(p)}catch(e){}}

  // ── 画面を消さない（対応している端末のみ）──
  function keepAwake(){
    try{
      if('wakeLock' in navigator&&!wakeLock&&document.visibilityState==='visible'){
        navigator.wakeLock.request('screen').then(function(l){
          wakeLock=l;l.addEventListener('release',function(){wakeLock=null});
        }).catch(function(){});
      }
    }catch(e){}
  }

  window.enableAlert=function(){
    unlockAudio();beep(2);vibrate(200);keepAwake();
    $('alert-btn').textContent='🔔 音とバイブのお知らせ：オン';
    $('alert-btn').classList.add('on');
    $('alert-note').innerHTML='準備OK！呼ばれたら音とバイブでお知らせするき。<br>この画面を開いたままにしちょってね。';
  };
  // どこかをタップした時も音を使えるようにしておく（iPhoneは操作が必要なため）
  document.addEventListener('touchend',unlockAudio,{once:true});
  document.addEventListener('click',unlockAudio,{once:true});

  // ── 呼び出しアラーム ──
  function ring(){
    if(acked)return;
    beep(6);
    vibrate([500,200,500,200,800]);
  }
  function startAlarm(){
    acked=false;
    stopAlarm();
    ring();
    alarmTimer=setInterval(function(){
      if(acked||remain()<=0){stopAlarm();return;}
      ring();
    },15000);
    $('ack-btn').style.display='inline-block';
  }
  function stopAlarm(){if(alarmTimer){clearInterval(alarmTimer);alarmTimer=null}}
  window.ack=function(){acked=true;stopAlarm();vibrate(0);$('ack-btn').style.display='none'};

  function remain(){return calledAtMs?LIMIT-((Date.now()+OFFSET)-calledAtMs):LIMIT}
  function pad(n){return (n<10?'0':'')+n}
  function tickTimer(){
    if(state.status!=='called')return;
    var r=remain(),el=$('call-timer');
    if(r<=0){
      el.textContent='時間切れ';
      el.classList.add('over');
      $('call-timer-label').textContent='急いでお店に声かけてや！';
      document.title='【時間切れ】'+baseTitle;
    }else{
      var m=Math.floor(r/60000),s=Math.floor((r%60000)/1000);
      el.textContent=pad(m)+':'+pad(s);
      el.classList.toggle('warn',r<120000);
      el.classList.remove('over');
      $('call-timer-label').textContent='残り時間';
      document.title=(s%2?'【呼出中】':'📣')+baseTitle;
    }
  }
  setInterval(tickTimer,1000);

  function showEnd(html){
    stopped=true;stopAlarm();
    document.body.classList.remove('called');
    $('call-screen').style.display='none';
    $('pa').style.display='none';
    $('wait-note').style.display='none';
    $('alert-box').style.display='none';
    $('end-area').innerHTML=html;
    $('end-area').style.display='block';
    $('upd').textContent='';
    document.title=baseTitle;
  }

  function apply(d){
    if(!d||!d.found){
      showEnd('この受付は取り消されたで。<br>わからんことがあったら、お店の人に声かけてや〜');return;
    }
    state.status=d.status;
    if($('line-on')&&d.linked){$('line-off').style.display='none';$('line-on').style.display='block'}

    if(d.status==='called'){
      calledAtMs=Date.parse(d.called_at)||calledAtMs||(Date.now()+OFFSET);
      document.body.classList.add('called');
      $('call-screen').style.display='block';
      $('pa').style.display='none';
      $('wait-note').style.display='none';
      $('head').textContent='順番きたで！';
      if(d.called_at!==lastCalledAt){
        lastCalledAt=d.called_at;
        startAlarm();
        window.scrollTo(0,0);
      }
      tickTimer();
    }else if(d.status==='waiting'){
      stopAlarm();lastCalledAt='';calledAtMs=0;
      document.body.classList.remove('called');
      $('call-screen').style.display='none';
      $('pa').style.display='block';
      $('wait-note').style.display='block';
      $('head').textContent='受付できたで！';
      $('pos').textContent=d.position;
      document.title=baseTitle;
    }else if(d.status==='done'){
      showEnd('<b style="color:#06c755;font-size:1.2em">ご来店ありがとうございました！</b><br>また来てや〜');
    }else if(d.status==='skipped'){
      showEnd('時間内に来られんかったき、順番を次に回したで。<br>お店の人に声かけてや〜');
    }
  }

  function poll(){
    if(stopped)return;
    fetch('/api/position/'+ID,{cache:'no-store'})
      .then(function(r){return r.json()})
      .then(apply)
      .catch(function(){});
  }

  apply({found:true,status:state.status,position:state.position,called_at:state.called_at,linked:state.linked});
  setInterval(poll,10000);
  document.addEventListener('visibilitychange',function(){
    if(document.visibilityState==='visible'){poll();keepAwake();}
  });
})();
</script>`,
`.lbtn{display:block;width:100%;padding:14px;border-radius:10px;font-size:1em;font-weight:bold;text-align:center;text-decoration:none;color:#fff;border:none;cursor:pointer}
.lbtn-main,.lbtn-add{background:#06c755}
.lbtn-main:active,.lbtn-add:active{background:#05a648}
.lbtn-link{background:#4a90d9}
.lbtn-link:active{background:#3a7bc0}
.lbtn-alert{background:#ff9800}
.lbtn-alert.on{background:#fff3e0;color:#e65100;border:2px solid #ffb74d}
.lnote{color:#888;font-size:.78em;margin-top:8px;line-height:1.6}
body.called{background:#ff9800}
.call-card{text-align:center;background:#fff;border:6px solid #e65100;animation:pulse 1.2s ease-in-out infinite}
.call-icon{font-size:3.5em;line-height:1}
.call-msg{font-size:1.45em;font-weight:bold;color:#e65100;line-height:1.6;margin:12px 0 18px}
.call-timer-label{color:#666;font-size:.9em}
.call-timer{font-family:monospace;font-size:3.6em;font-weight:bold;color:#333;letter-spacing:.04em}
.call-timer.warn{color:#e53935}
.call-timer.over{color:#e53935;font-size:2.4em}
.ack-btn{margin-top:16px;padding:14px 24px;border:none;border-radius:10px;background:#e65100;color:#fff;font-size:1em;font-weight:bold;cursor:pointer}
@keyframes pulse{0%,100%{box-shadow:0 0 0 0 rgba(230,81,0,.6)}50%{box-shadow:0 0 0 14px rgba(230,81,0,0)}}`));
});

// ══════════════════════════════════════════
//  GET /status ── 待ち状況（公開）
// ══════════════════════════════════════════
app.get('/status', (_req, res) => {
  const waiting = Q.waiting.all();
  const called  = Q.called.all();

  const calledHtml = called.map(t =>
    `<div class="tk called"><span class="tn">#${t.id}</span>${esc(t.name)}さん（${t.people}名）<span class="bd bc">呼出中</span></div>`
  ).join('');

  const waitHtml = waiting.length > 0
    ? waiting.map((t, i) =>
      `<div class="tk"><span class="tn">#${t.id}</span>${esc(t.name)}さん（${t.people}名）<span class="bd">${i+1}番目</span></div>`
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

  const WAIT_TH = '<tr><th>No</th><th>名前</th><th>電話</th><th>人数</th><th>待ち時間</th><th>LINE</th><th>操作</th></tr>';
  const CALL_TH = '<tr><th>No</th><th>名前</th><th>電話</th><th>人数</th><th>残り</th><th>操作</th></tr>';

  function lineBadge(t) {
    return t.line_user_id
      ? '<span class="ln-on">✅連携</span>'
      : '<span class="ln-off">未連携</span>';
  }

  function waitRow(t) {
    const createdMs = parseCreatedAt(t.created_at);
    const elapsed = createdMs ? formatElapsed(Date.now() - createdMs) : '-';
    const jst = createdMs ? '受付 ' + formatJstTime(createdMs) : '';
    const btns = `<button class="btn bg sm" onclick="act('call',${t.id})">呼び出し</button> <button class="btn br sm" onclick="act('delete',${t.id})">削除</button>`;
    return `<tr><td><b>#${t.id}</b></td><td>${esc(t.name)}</td><td>${esc(t.phone)||'-'}</td><td>${t.people}名</td><td class="wait-cell" data-created-ms="${createdMs || ''}" title="${jst}">${elapsed}</td><td>${lineBadge(t)}</td><td>${btns}</td></tr>`;
  }

  function callRow(t) {
    const ca = esc(t.called_at || '');
    const btns = `<button class="btn bo sm" onclick="act('recall',${t.id})">再呼出</button> <button class="btn bo sm" onclick="act('done',${t.id})">完了</button> <button class="btn bg2 sm" onclick="act('requeue',${t.id})">戻す</button>`;
    const skipBtn = `<button class="btn br sm skip-btn" onclick="act('skip',${t.id})" style="display:none" data-skip-id="${t.id}">飛ばす</button>`;
    return `<tr data-called-at="${ca}" data-id="${t.id}"><td><b>#${t.id}</b></td><td>${esc(t.name)} ${t.line_user_id ? '<span class="ln-on" title="LINE連携済み">✅</span>' : ''}</td><td>${esc(t.phone)||'-'}</td><td>${t.people}名</td><td class="timer-cell">--:--</td><td>${btns} ${skipBtn}</td></tr>`;
  }

  const waitRows = waiting.map(t => waitRow(t)).join('');
  const callRows = called.map(t => callRow(t)).join('');

  const lineMode = CUSTOMER_LINE_READY
    ? '<span style="color:#06c755">お客さんLINE通知：オン（連携した人に届く）</span>'
    : `<span style="color:#999">お客さんLINE通知：オフ${!ENABLE_CUSTOMER_PUSH ? '（ENABLE_CUSTOMER_PUSH=false）' : !lineClient ? '（LINEトークン未設定）' : '（LINE_OFFICIAL_ID 未設定）'}／受付後の画面には表示されます</span>`;

  res.send(layout(`${STORE_NAME} 管理`, `
<div class="card">
  <h1 style="color:#06c755;font-size:1.2em;margin-bottom:6px">${STORE_NAME} 管理画面</h1>
  <p style="font-size:.75em;margin-bottom:14px">${lineMode}</p>
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
var LIMIT=${CALL_LIMIT_MS};
// サーバーとスマホ/PCの時計のずれを補正（待ち時間の計算用）
var CLOCK_OFFSET=${Date.now()}-Date.now();
function fmtWait(ms){
  if(ms<60000)return '1分未満';
  var min=Math.floor(ms/60000);
  if(min<60)return min+'分';
  return Math.floor(min/60)+'時間'+(min%60)+'分';
}
function tickWait(){
  var now=Date.now()+CLOCK_OFFSET;
  document.querySelectorAll('.wait-cell[data-created-ms]').forEach(function(td){
    var c=parseInt(td.getAttribute('data-created-ms'),10);
    if(!c)return;
    td.textContent=fmtWait(Math.max(0,now-c));
  });
}
tickWait();setInterval(tickWait,1000);
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
.timer-cell{font-family:monospace;font-size:1.1em;min-width:56px}
.ln-on{color:#06c755;font-weight:bold}
.ln-off{color:#bbb;font-size:.9em}`));
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

  const callMsg = callMessage(id);

  // 管理者へLINE通知
  if (ADMIN_USER_ID) {
    await pushMsg(ADMIN_USER_ID, callMsg);
  }

  // お客さんへLINE通知（LINE連携済みの人だけ）
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
//  GET /api/position/:id ── 順番確認API（受付後の画面が10秒ごとに使う）
// ══════════════════════════════════════════
app.get('/api/position/:id', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const id = parseInt(req.params.id, 10);
  const t  = Q.get.get(id);
  if (!t) return res.json({ found: false, status: 'unknown', position: 0, total: 0 });

  const total  = Q.cntWait.get().c;
  const linked = !!t.line_user_id;
  if (t.status === 'called') {
    return res.json({ found: true, status: 'called', position: 0, total, called_at: t.called_at || '', limit_ms: CALL_LIMIT_MS, linked });
  }
  if (t.status === 'done')    return res.json({ found: true, status: 'done',    position: 0, total: 0, linked });
  if (t.status === 'skipped') return res.json({ found: true, status: 'skipped', position: 0, total, linked });

  const pos = Q.position.get(id).p + 1;
  res.json({ found: true, status: 'waiting', position: pos, total, linked });
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

  // ── 友だち追加された時：連携のやり方を案内（返信なので無料） ──
  if (event.type === 'follow' && event.replyToken) {
    if (!ENABLE_CUSTOMER_PUSH) return;
    return replyMsg(event.replyToken,
      `友だち追加ありがとう！${STORE_NAME}やき。\n\n` +
      `順番待ちの受付をした人は、受付後の画面に戻って「② 連携メッセージを送る」を押してや〜。\n` +
      `呼ばれたら、ここにお知らせするき！`
    );
  }

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
    if (!t.link_token || tokenInput.length < 8 || !t.link_token.startsWith(tokenInput)) {
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
//  サーバー起動
// ══════════════════════════════════════════
app.listen(PORT, () => {
  console.log(`=== ${STORE_NAME} 順番待ちシステム v5 ===`);
  console.log(`PORT             : ${PORT}`);
  console.log(`BASE_URL         : ${BASE_URL || '(自動検出)'}`);
  console.log(`LINE SDK         : ${lineClient ? 'OK' : '未設定'}`);
  console.log(`ADMIN_USER_ID    : ${ADMIN_USER_ID ? ADMIN_USER_ID.substring(0, 8) + '...' : '未設定'}`);
  console.log(`CUSTOMER_PUSH    : ${ENABLE_CUSTOMER_PUSH ? 'ON' : 'OFF'}`);
  console.log(`CUSTOMER LINE UI : ${CUSTOMER_LINE_READY ? 'ON' : 'OFF（LINE_OFFICIAL_ID か LINE_ADD_FRIEND_URL が必要）'}`);
  console.log(`Routes           : / /form /register /ticket/:id /status /admin /admin/qr /webhook`);
  console.log('==========================================');
});
