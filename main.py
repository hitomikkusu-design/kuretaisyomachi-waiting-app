import os
import re
import sqlite3
import secrets
from datetime import datetime

from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, JSONResponse

from linebot import LineBotApi, WebhookHandler
from linebot.exceptions import InvalidSignatureError
from linebot.models import MessageEvent, TextMessage, TextSendMessage

# ========= ENV =========
LINE_CHANNEL_ACCESS_TOKEN = os.getenv("LINE_CHANNEL_ACCESS_TOKEN", "")
LINE_CHANNEL_SECRET = os.getenv("LINE_CHANNEL_SECRET", "")
ADMIN_PASS = os.getenv("ADMIN_PASS", "")  # 例：taisho123（空なら誰でも呼出できる）

# DB（今の運用に合わせて固定）
DB_DIR = "/opt/render/project/src/db"
DB_PATH = os.path.join(DB_DIR, "queue.db")

SHOP_NAME = "山本鮮魚店"

app = FastAPI()
line_bot_api = LineBotApi(LINE_CHANNEL_ACCESS_TOKEN)
handler = WebhookHandler(LINE_CHANNEL_SECRET)

os.makedirs(DB_DIR, exist_ok=True)

# ========= DB =========
def init_db():
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("""
    CREATE TABLE IF NOT EXISTS queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        shop TEXT NOT NULL,
        number INTEGER NOT NULL,
        name TEXT NOT NULL,
        phone TEXT NOT NULL,
        party_size INTEGER NOT NULL,
        status TEXT NOT NULL,           -- waiting/called/canceled/done
        created_at TEXT NOT NULL,
        called_at TEXT,
        line_user_id TEXT,              -- nullでもOK（後で連携）
        link_code TEXT                  -- 連携用6桁コード
    )
    """)
    # ちょい安全：link_code検索用
    c.execute("CREATE INDEX IF NOT EXISTS idx_queue_link_code ON queue(link_code)")
    c.execute("CREATE INDEX IF NOT EXISTS idx_queue_status ON queue(status)")
    conn.commit()
    conn.close()

def conn():
    return sqlite3.connect(DB_PATH)

def next_number(shop: str) -> int:
    cn = conn()
    c = cn.cursor()
    c.execute("SELECT COALESCE(MAX(number), 0) + 1 FROM queue WHERE shop=?", (shop,))
    n = int(c.fetchone()[0])
    cn.close()
    return n

def count_ahead(shop: str, number: int) -> int:
    cn = conn()
    c = cn.cursor()
    c.execute("SELECT COUNT(*) FROM queue WHERE shop=? AND status='waiting' AND number < ?", (shop, number))
    ahead = int(c.fetchone()[0])
    cn.close()
    return ahead

def gen_link_code() -> str:
    # 6桁（衝突したら作り直す）
    for _ in range(5):
        code = str(secrets.randbelow(900000) + 100000)
        cn = conn()
        c = cn.cursor()
        c.execute("SELECT COUNT(*) FROM queue WHERE link_code=?", (code,))
        exists = int(c.fetchone()[0]) > 0
        cn.close()
        if not exists:
            return code
    # 最後の手段
    return str(secrets.randbelow(900000) + 100000)

def register_web(shop: str, name: str, phone: str, party_size: int) -> dict:
    number = next_number(shop)
    link_code = gen_link_code()
    cn = conn()
    c = cn.cursor()
    c.execute("""
        INSERT INTO queue (shop, number, name, phone, party_size, status, created_at, line_user_id, link_code)
        VALUES (?, ?, ?, ?, ?, 'waiting', ?, NULL, ?)
    """, (shop, number, name, phone, party_size, datetime.now().isoformat(), link_code))
    cn.commit()
    cn.close()

    ahead = count_ahead(shop, number)
    return {"number": number, "ahead": ahead, "link_code": link_code}

def link_line_user(shop: str, link_code: str, line_user_id: str) -> dict:
    # 最新のwaitingを優先で紐付け（同コードは基本1つ）
    cn = conn()
    c = cn.cursor()
    c.execute("""
        SELECT id, number, party_size, status FROM queue
        WHERE shop=? AND link_code=?
        ORDER BY id DESC LIMIT 1
    """, (shop, link_code))
    row = c.fetchone()
    if not row:
        cn.close()
        return {"ok": False, "error": "その連携コード、見つからんかったき。もう一回QRから受付してね。"}

    qid, number, party_size, status = int(row[0]), int(row[1]), int(row[2]), row[3]
    if status != "waiting":
        cn.close()
        return {"ok": False, "error": "その番号はもう待ち状態じゃないき。新しく受付してね。"}

    # すでに他の人に紐付いてたら上書き防止
    c.execute("SELECT line_user_id FROM queue WHERE id=?", (qid,))
    current = c.fetchone()[0]
    if current and current != line_user_id:
        cn.close()
        return {"ok": False, "error": "この連携コードはもう使われちゅうき。"}

    c.execute("UPDATE queue SET line_user_id=? WHERE id=?", (line_user_id, qid))
    cn.commit()
    cn.close()

    ahead = count_ahead(shop, number)
    return {"ok": True, "number": number, "party_size": party_size, "ahead": ahead}

def get_latest_waiting_by_line(shop: str, line_user_id: str):
    cn = conn()
    c = cn.cursor()
    c.execute("""
        SELECT number, party_size FROM queue
        WHERE shop=? AND line_user_id=? AND status='waiting'
        ORDER BY id DESC LIMIT 1
    """, (shop, line_user_id))
    row = c.fetchone()
    if not row:
        cn.close()
        return None
    number, party_size = int(row[0]), int(row[1])
    ahead = count_ahead(shop, number)
    cn.close()
    return {"number": number, "party_size": party_size, "ahead": ahead}

def cancel_latest_by_line(shop: str, line_user_id: str) -> bool:
    cn = conn()
    c = cn.cursor()
    c.execute("""
        SELECT id FROM queue
        WHERE shop=? AND line_user_id=? AND status='waiting'
        ORDER BY id DESC LIMIT 1
    """, (shop, line_user_id))
    row = c.fetchone()
    if not row:
        cn.close()
        return False
    qid = int(row[0])
    c.execute("UPDATE queue SET status='canceled' WHERE id=?", (qid,))
    cn.commit()
    cn.close()
    return True

def call_number(shop: str, number: int):
    cn = conn()
    c = cn.cursor()
    c.execute("""
        SELECT id, name, phone, party_size, line_user_id
        FROM queue
        WHERE shop=? AND number=? AND status='waiting'
        ORDER BY id DESC LIMIT 1
    """, (shop, number))
    row = c.fetchone()
    if not row:
        cn.close()
        return None

    qid, name, phone, party_size, line_user_id = int(row[0]), row[1], row[2], int(row[3]), row[4]
    c.execute("UPDATE queue SET status='called', called_at=? WHERE id=?", (datetime.now().isoformat(), qid))
    cn.commit()
    cn.close()
    return {"name": name, "phone": phone, "party_size": party_size, "line_user_id": line_user_id}

init_db()

# ========= Routes =========
@app.get("/status")
def status():
    return {"ok": True, "shop": SHOP_NAME}

<h2>受付が完了しました</h2>

<p>
呼び出しは<br>
<strong>山本鮮魚店 公式LINE</strong> に届きます。
</p>

<p>
【重要】<br>
このあと <strong>必ず</strong> 下のボタンを押して<br>
LINEを開いてください。
</p>

<a href="https://lin.ee/0uwScY2"
   style="
     display:inline-block;
     padding:14px 22px;
     background:#06C755;
     color:#fff;
     font-size:18px;
     font-weight:bold;
     border-radius:8px;
     text-decoration:none;
   ">
▶ LINEを開く
</a>

<p style="margin-top:16px; font-size:14px;">
※ 呼び出しはLINEでのみ行います
</p>
