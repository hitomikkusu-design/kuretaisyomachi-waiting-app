import os
import re
import json
import time
import sqlite3
from datetime import datetime
from fastapi import FastAPI, Request, Form
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
import httpx
import hmac
import hashlib
import base64

# =========================
# Env
# =========================
LINE_CHANNEL_ACCESS_TOKEN = os.getenv("LINE_CHANNEL_ACCESS_TOKEN", "")
LINE_CHANNEL_SECRET = os.getenv("LINE_CHANNEL_SECRET", "")
LIFF_ID = os.getenv("LIFF_ID", "")
ADMIN_PASS = os.getenv("ADMIN_PASS", "")  # 空ならパス無し運用
DB_DIR = os.getenv("DB_DIR", "/opt/render/project/src/db")

# 公式アカウントの short link（ひとみさんが貼ってくれたやつ）
OA_SHORT_LINK = "https://lin.ee/0uwScY2"

# =========================
# App
# =========================
app = FastAPI()

SHOP_NAME = "山本鮮魚店"
SHOPS = ["山本鮮魚店", "漁師小屋", "浜ちゃん"]  # 3店対応

# =========================
# DB
# =========================
def ensure_db_dir():
    os.makedirs(DB_DIR, exist_ok=True)

def db_path():
    return os.path.join(DB_DIR, "waiting.sqlite3")

def get_conn():
    ensure_db_dir()
    conn = sqlite3.connect(db_path(), check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    with get_conn() as conn:
        conn.execute("""
        CREATE TABLE IF NOT EXISTS tickets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            shop TEXT NOT NULL,
            name TEXT NOT NULL,
            phone TEXT NOT NULL,
            party_size INTEGER NOT NULL,
            line_user_id TEXT,
            status TEXT NOT NULL DEFAULT 'waiting',  -- waiting/called/done
            created_at TEXT NOT NULL
        )
        """)
        conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_tickets_shop_status_created
        ON tickets(shop, status, created_at)
        """)
init_db()

def now_iso():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")

def next_number(shop: str):
    # 「今日の番号」みたいな厳密運用まで要らんなら、通し番号でOK
    with get_conn() as conn:
        cur = conn.execute("SELECT COUNT(*) AS c FROM tickets WHERE shop=?", (shop,))
        return int(cur.fetchone()["c"]) + 1

def get_waiting_count(shop: str):
    with get_conn() as conn:
        cur = conn.execute("SELECT COUNT(*) AS c FROM tickets WHERE shop=? AND status='waiting'", (shop,))
        return int(cur.fetchone()["c"])

def create_ticket(shop: str, name: str, phone: str, party_size: int, line_user_id: str | None):
    created_at = now_iso()
    with get_conn() as conn:
        conn.execute(
            "INSERT INTO tickets (shop, name, phone, party_size, line_user_id, status, created_at) VALUES (?,?,?,?,?,'waiting',?)",
            (shop, name, phone, party_size, line_user_id, created_at)
        )
        ticket_id = conn.execute("SELECT last_insert_rowid() AS id").fetchone()["id"]
    return ticket_id

def mark_called(shop: str, ticket_id: int):
    with get_conn() as conn:
        conn.execute("UPDATE tickets SET status='called' WHERE shop=? AND id=?", (shop, ticket_id))

def find_ticket(ticket_id: int):
    with get_conn() as conn:
        cur = conn.execute("SELECT * FROM tickets WHERE id=?", (ticket_id,))
        row = cur.fetchone()
    return dict(row) if row else None

# =========================
# LINE helpers
# =========================
async def line_push(user_id: str, text: str):
    if not LINE_CHANNEL_ACCESS_TOKEN:
        return
    url = "https://api.line.me/v2/bot/message/push"
    headers = {
        "Authorization": f"Bearer {LINE_CHANNEL_ACCESS_TOKEN}",
        "Content-Type": "application/json"
    }
    payload = {
        "to": user_id,
        "messages": [{"type": "text", "text": text}]
    }
    async with httpx.AsyncClient(timeout=10) as client:
        await client.post(url, headers=headers, json=payload)

def verify_line_signature(body: bytes, signature: str) -> bool:
    if not LINE_CHANNEL_SECRET:
        return False
    mac = hmac.new(LINE_CHANNEL_SECRET.encode("utf-8"), body, hashlib.sha256).digest()
    expected = base64.b64encode(mac).decode("utf-8")
    return hmac.compare_digest(expected, signature)

# =========================
# Routes
# =========================
@app.get("/status")
def status():
    return {"ok": True, "shop": SHOP_NAME}

@app.get("/", response_class=HTMLResponse)
def root():
    return RedirectResponse(url="/reception", status_code=302)

# --- 受付フォーム：LIFF版（LINEアプリ内で開く想定。userId取れる） ---
@app.get("/liff", response_class=HTMLResponse)
def liff_page():
    # LIFF_IDが空なら案内
    if not LIFF_ID:
        return HTMLResponse("<h3>LIFF_ID が未設定です。RenderのEnvironmentに LIFF_ID を追加してください。</h3>")

    shop_options = "\n".join([f'<option value="{s}">{s}</option>' for s in SHOPS])

    return f"""<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>受付（{SHOP_NAME}）</title>
  <script src="https://static.line-scdn.net/liff/edge/2/sdk.js"></script>
  <style>
    body{{font-family:system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans JP",sans-serif;background:#f6f7f8;margin:0;padding:16px}}
    .card{{background:#fff;border-radius:14px;padding:16px;box-shadow:0 6px 20px rgba(0,0,0,.06);max-width:520px;margin:0 auto}}
    h1{{font-size:18px;margin:0 0 12px}}
    label{{display:block;font-size:13px;margin:12px 0 6px}}
    input,select{{width:100%;padding:12px;border:1px solid #ddd;border-radius:10px;font-size:16px}}
    .primary{{width:100%;margin-top:14px;padding:14px;border:0;border-radius:12px;background:#111;color:#fff;font-size:16px}}
    .note{{font-size:12px;color:#666;margin-top:10px;line-height:1.55}}
    .ok{{margin-top:12px;padding:12px;border-radius:12px;background:#f0fff4;border:1px solid #bfe7c7}}
    .err{{margin-top:12px;padding:12px;border-radius:12px;background:#fff3f3;border:1px solid #f0b4b4}}
  </style>
</head>
<body>
  <div class="card">
    <h1>受付フォーム（{SHOP_NAME}）</h1>

    <div id="profile" class="note">LINE確認中…</div>

    <label>店舗</label>
    <select id="shop">{shop_options}</select>

    <label>お名前</label>
    <input id="name" placeholder="例：ひとみ"/>

    <label>人数</label>
    <input id="party" type="number" min="1" max="20" value="2"/>

    <label>電話番号</label>
    <input id="phone" inputmode="tel" placeholder="例：09012345678"/>

    <button class="primary" onclick="submitForm()">受付する</button>

    <div id="msg"></div>
    <div class="note">
      ※ 受付後に「受付完了メッセージ」がLINEに届きます。<br/>
      ※ AndroidでLINE外ブラウザから開くとログインが出ることがあります。できるだけLINE内で開いてください。
    </div>
  </div>

<script>
let LINE_USER_ID = "";

async function init() {{
  try {{
    await liff.init({{ liffId: "{LIFF_ID}" }});
    if (!liff.isLoggedIn()) {{
      // LINE外で開いた時にログイン誘導になる（仕様）
      liff.login();
      return;
    }}
    const prof = await liff.getProfile();
    LINE_USER_ID = prof.userId;
    document.getElementById("profile").textContent = "LINE確認OK： " + (prof.displayName || "");
    // 名前欄に入れておく（編集できる）
    if (!document.getElementById("name").value) {{
      document.getElementById("name").value = prof.displayName || "";
    }}
  }} catch(e) {{
    document.getElementById("profile").textContent = "LINE確認でエラー。通信状況を確認してね。";
  }}
}}

async function submitForm() {{
  const shop = document.getElementById("shop").value;
  const name = document.getElementById("name").value.trim();
  const phone = document.getElementById("phone").value.trim();
  const party = parseInt(document.getElementById("party").value, 10);

  if (!shop || !name || !phone || !party) {{
    document.getElementById("msg").innerHTML = '<div class="err">未入力があります。</div>';
    return;
  }}

  const res = await fetch("/api/register", {{
    method: "POST",
    headers: {{ "Content-Type": "application/json" }},
    body: JSON.stringify({{ shop, name, phone, party_size: party, line_user_id: LINE_USER_ID }})
  }});

  const data = await res.json();
  if (data.ok) {{
    document.getElementById("msg").innerHTML =
      '<div class="ok">受付完了！<br/>番号：<b>' + data.ticket_id + '</b>　/　あと<b>' + data.waiting + '</b>組くらい<br/><br/>LINEにメッセージ送ったよ。</div>';
  }} else {{
    document.getElementById("msg").innerHTML = '<div class="err">' + (data.error || "失敗") + '</div>';
  }}
}}

init();
</script>
</body>
</html>
"""

# --- 受付フォーム：普通ブラウザ版（ログイン不要） ---
# ただし userId が取れない＝自動通知は弱くなる（本人に届かない可能性）
@app.get("/reception", response_class=HTMLResponse)
def reception_page():
    shop_options = "\n".join([f'<option value="{s}">{s}</option>' for s in SHOPS])
    return f"""<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>{SHOP_NAME} 受付</title>
  <style>
    body{{font-family:system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans JP",sans-serif;background:#f6f7f8;margin:0;padding:16px}}
    .card{{background:#fff;border-radius:14px;padding:16px;box-shadow:0 6px 20px rgba(0,0,0,.06);max-width:520px;margin:0 auto}}
    h1{{font-size:18px;margin:0 0 12px}}
    label{{display:block;font-size:13px;margin:12px 0 6px}}
    input,select{{width:100%;padding:12px;border:1px solid #ddd;border-radius:10px;font-size:16px}}
    .primary{{width:100%;margin-top:14px;padding:14px;border:0;border-radius:12px;background:#111;color:#fff;font-size:16px}}
    .note{{font-size:12px;color:#666;margin-top:10px;line-height:1.55}}
  </style>
</head>
<body>
  <div class="card">
    <h1>受付フォーム（ログイン不要）</h1>

    <label>店舗</label>
    <select name="shop" id="shop">{shop_options}</select>

    <label>お名前</label>
    <input id="name" placeholder="例：ひとみ"/>

    <label>人数</label>
    <input id="party" type="number" min="1" max="20" value="2"/>

    <label>電話番号</label>
    <input id="phone" inputmode="tel" placeholder="例：09012345678"/>

    <button class="primary" onclick="submitForm()">受付する</button>

    <div class="note">
      ※ 受付後、LINEに移動して「受付完了」を確認してね（自動で開くのは端末によって止められることがあります）。
    </div>
  </div>

<script>
async function submitForm() {{
  const shop = document.getElementById("shop").value;
  const name = document.getElementById("name").value.trim();
  const phone = document.getElementById("phone").value.trim();
  const party = parseInt(document.getElementById("party").value, 10);

  if (!shop || !name || !phone || !party) {{
    alert("未入力があります");
    return;
  }}

  const res = await fetch("/api/register", {{
    method: "POST",
    headers: {{ "Content-Type": "application/json" }},
    body: JSON.stringify({{ shop, name, phone, party_size: party, line_user_id: null }})
  }});
  const data = await res.json();
  if (!data.ok) {{
    alert(data.error || "失敗");
    return;
  }}

  // LINEを開く（端末がブロックする場合もある）
  location.href = "{OA_SHORT_LINK}";
}}
</script>
</body>
</html>
"""

@app.post("/api/register")
async def api_register(payload: dict):
    try:
        shop = str(payload.get("shop", "")).strip()
        name = str(payload.get("name", "")).strip()
        phone = str(payload.get("phone", "")).strip()
        party_size = int(payload.get("party_size", 0))
        line_user_id = payload.get("line_user_id")

        if shop not in SHOPS:
            return JSONResponse({"ok": False, "error": "店舗が不正です"}, status_code=400)
        if not name or not phone or party_size <= 0:
            return JSONResponse({"ok": False, "error": "入力が不足です"}, status_code=400)

        ticket_id = create_ticket(shop, name, phone, party_size, line_user_id)
        waiting = get_waiting_count(shop) - 1  # 自分の前の組数っぽく

        # お客さん向けLINE通知（userId取れてる時だけ）
        if line_user_id:
            msg = (
                f"{shop} 受付できたで！\n"
                f"受付番号：{ticket_id}\n"
                f"あと {max(waiting,0)} 組くらい。\n\n"
                f"呼ばれたらこのLINEに来るき、待ちよってね。"
            )
            await line_push(line_user_id, msg)

        return {"ok": True, "ticket_id": ticket_id, "waiting": max(waiting, 0)}
    except Exception as e:
        return JSONResponse({"ok": False, "error": f"例外：{e}"}, status_code=500)

# --- LINE Webhook ---
@app.post("/webhook/line")
async def webhook_line(request: Request):
    body = await request.body()
    signature = request.headers.get("X-Line-Signature", "")
    if not verify_line_signature(body, signature):
        return JSONResponse({"ok": False, "error": "invalid signature"}, status_code=400)

    data = json.loads(body.decode("utf-8"))
    events = data.get("events", [])

    for ev in events:
        if ev.get("type") != "message":
            continue
        msg = ev.get("message", {})
        if msg.get("type") != "text":
            continue

        text = (msg.get("text") or "").strip()
        user_id = ev.get("source", {}).get("userId", "")

        # --- スタッフ呼び出し ---
        # 例： 呼出 12 taisho123
        m = re.match(r"^呼出\s+(\d+)(?:\s+(\S+))?$", text)
        if m:
            ticket_id = int(m.group(1))
            passed = (m.group(2) or "")

            if ADMIN_PASS and passed != ADMIN_PASS:
                await line_push(user_id, "合言葉が違うき、もう一回やってみて。例：呼出 12 合言葉")
                continue

            t = find_ticket(ticket_id)
            if not t:
                await line_push(user_id, f"その番号（{ticket_id}）は見つからんかったで。")
                continue

            mark_called(t["shop"], ticket_id)

            # お客さんへ通知（line_user_idあるときだけ）
            if t.get("line_user_id"):
                await line_push(
                    t["line_user_id"],
                    f"{t['shop']} から呼び出しやき！\n受付番号：{ticket_id}\nそろそろ来てね。"
                )

            await line_push(user_id, f"呼び出し送ったで！番号：{ticket_id}")
            continue

        # --- スタッフヘルプ ---
        if text in ["ヘルプ", "help", "使い方"]:
            hint = (
                "【スタッフ用】\n"
                "呼出 12 合言葉\n"
                "（合言葉が無い運用なら：呼出 12）"
            )
            await line_push(user_id, hint)
            continue

    return {"ok": True}
