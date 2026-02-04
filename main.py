import os
import re
import sqlite3
from datetime import datetime
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from linebot import LineBotApi, WebhookHandler
from linebot.exceptions import InvalidSignatureError
from linebot.models import MessageEvent, TextMessage, TextSendMessage

# =========================
# 環境変数
# =========================
LINE_CHANNEL_ACCESS_TOKEN = os.getenv("LINE_CHANNEL_ACCESS_TOKEN")
LINE_CHANNEL_SECRET = os.getenv("LINE_CHANNEL_SECRET")
ADMIN_PASS = os.getenv("ADMIN_PASS", "")  # 例：taisho123

DB_DIR = "/opt/render/project/src/db"
DB_PATH = os.path.join(DB_DIR, "queue.db")

SHOP_NAME = "山本鮮魚店"

# =========================
# 初期化
# =========================
app = FastAPI()
line_bot_api = LineBotApi(LINE_CHANNEL_ACCESS_TOKEN)
handler = WebhookHandler(LINE_CHANNEL_SECRET)

os.makedirs(DB_DIR, exist_ok=True)

def init_db():
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("""
    CREATE TABLE IF NOT EXISTS queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        number INTEGER,
        user_id TEXT,
        status TEXT,
        created_at TEXT
    )
    """)
    conn.commit()
    conn.close()

init_db()

def get_next_number():
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("SELECT COALESCE(MAX(number), 0) + 1 FROM queue")
    num = c.fetchone()[0]
    conn.close()
    return num

def register_user(user_id):
    num = get_next_number()
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute(
        "INSERT INTO queue (number, user_id, status, created_at) VALUES (?, ?, 'waiting', ?)",
        (num, user_id, datetime.now().isoformat())
    )
    conn.commit()
    conn.close()
    return num

def get_user_status(user_id):
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute(
        "SELECT number FROM queue WHERE user_id=? AND status='waiting' ORDER BY id DESC LIMIT 1",
        (user_id,)
    )
    row = c.fetchone()
    if not row:
        conn.close()
        return None, None
    number = row[0]
    c.execute(
        "SELECT COUNT(*) FROM queue WHERE status='waiting' AND number < ?",
        (number,)
    )
    ahead = c.fetchone()[0]
    conn.close()
    return number, ahead

def call_number(number):
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute(
        "SELECT user_id FROM queue WHERE number=? AND status='waiting'",
        (number,)
    )
    row = c.fetchone()
    if not row:
        conn.close()
        return None
    user_id = row[0]
    c.execute(
        "UPDATE queue SET status='called' WHERE number=?",
        (number,)
    )
    conn.commit()
    conn.close()
    return user_id

# =========================
# ルート
# =========================
@app.get("/status")
def status():
    return {"ok": True}

@app.post("/webhook/line")
async def webhook(request: Request):
    signature = request.headers.get("X-Line-Signature")
    body = await request.body()
    try:
        handler.handle(body.decode("utf-8"), signature)
    except InvalidSignatureError:
        return JSONResponse({"ok": False}, status_code=400)
    return {"ok": True}

# =========================
# LINE処理
# =========================
@handler.add(MessageEvent, message=TextMessage)
def handle_message(event: MessageEvent):
    text = event.message.text.strip()
    user_id = event.source.user_id

    # 呼出（スタッフ）
    if text.startswith("呼出"):
        if ADMIN_PASS and ADMIN_PASS not in text:
            line_bot_api.reply_message(
                event.reply_token,
                TextSendMessage(text="合言葉が違うき。")
            )
            return

        m = re.search(r"(\d+)", text)
        if not m:
            return

        number = int(m.group(1))
        target = call_number(number)
        if not target:
            line_bot_api.reply_message(
                event.reply_token,
                TextSendMessage(text=f"{number}番はおらんき。")
            )
            return

        line_bot_api.push_message(
            target,
            TextSendMessage(
                text=(
                    "📣【呼出し｜山本鮮魚店】\n"
                    f"{number}番のお客さん\n\n"
                    "順番きたき。\n"
                    "5分以内に店の前まで来てつかあさい。\n\n"
                    "遅れる時は「遅れる」\n"
                    "来れん時は「キャンセル」って送って。"
                )
            )
        )

        line_bot_api.reply_message(
            event.reply_token,
            TextSendMessage(text=f"呼出したで：{number}")
        )
        return

    # 受付
    if "受付" in text:
        num = register_user(user_id)
        _, ahead = get_user_status(user_id)

        line_bot_api.reply_message(
            event.reply_token,
            TextSendMessage(
                text=(
                    "【受付完了｜山本鮮魚店】\n\n"
                    f"番号：{num}\n"
                    f"今のところ、あと{ahead}組ばあ\n\n"
                    "順番になったらLINEで呼ぶきね。\n"
                    "店の前で待たんでえいで。"
                )
            )
        )
        return

    # 状況
    if "状況" in text:
        num, ahead = get_user_status(user_id)
        if not num:
            line_bot_api.reply_message(
                event.reply_token,
                TextSendMessage(text="まだ受付しちょらんき。「受付」って送って。")
            )
            return

        line_bot_api.reply_message(
            event.reply_token,
            TextSendMessage(
                text=(
                    "【順番状況｜山本鮮魚店】\n\n"
                    f"番号：{num}\n"
                    f"今のところ、あと{ahead}組ばあ\n\n"
                    "順番になったらLINEで呼ぶきね。"
                )
            )
        )
        return

    # その他
    line_bot_api.reply_message(
        event.reply_token,
        TextSendMessage(
            text=(
                "ようこそ山本鮮魚店やき。\n\n"
                "使える言葉はこれだけ👇\n"
                "・受付\n"
                "・状況\n\n"
                "順番になったらLINEで呼ぶきね。"
            )
        )
    )
