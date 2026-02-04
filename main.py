import os
import re
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from linebot import LineBotApi, WebhookHandler
from linebot.exceptions import InvalidSignatureError
from linebot.models import MessageEvent, TextMessage, TextSendMessage

# =========================
# ENV
# =========================
LINE_CHANNEL_ACCESS_TOKEN = os.getenv("LINE_CHANNEL_ACCESS_TOKEN", "")
LINE_CHANNEL_SECRET = os.getenv("LINE_CHANNEL_SECRET", "")

# Render Persistent Disk を使う場合は /var/data を推奨
DB_DIR = os.getenv("DB_DIR", "/opt/render/project/src/db"
)
DB_PATH = os.getenv("DB_PATH", os.path.join(DB_DIR, "queue.db"))

DEFAULT_SHOP = os.getenv("DEFAULT_SHOP", "大正町")
ADMIN_PASS = os.getenv("ADMIN_PASS", "")  # スタッフ呼び出しに使う任意パス（空なら誰でも呼出できる）

# =========================
# App / LINE
# =========================
app = FastAPI()
line_bot_api = LineBotApi(LINE_CHANNEL_ACCESS_TOKEN)
handler = WebhookHandler(LINE_CHANNEL_SECRET)

# =========================
# DB Helpers
# =========================
def utc_now_iso() -> str:
    return datetime.utcnow().replace(tzinfo=timezone.utc).isoformat()

def ensure_db_dir():
    os.makedirs(DB_DIR, exist_ok=True)

@contextmanager
def get_conn():
    ensure_db_dir()
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
    finally:
        conn.close()

def init_db():
    with get_conn() as conn:
        c = conn.cursor()
        c.execute("""
        CREATE TABLE IF NOT EXISTS queue (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            created_at TEXT NOT NULL,
            shop TEXT NOT NULL,
            user_id TEXT NOT NULL,
            name TEXT,
            party_size INTEGER NOT NULL,
            number INTEGER NOT NULL,
            status TEXT NOT NULL,         -- waiting/called/canceled/done
            called_at TEXT,
            done_at TEXT
        )
        """)
        c.execute("CREATE INDEX IF NOT EXISTS idx_queue_user_status ON queue(user_id, status)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_queue_shop_number ON queue(shop, number)")
        conn.commit()

def next_number(conn, shop: str) -> int:
    c = conn.cursor()
    c.execute("SELECT COALESCE(MAX(number), 0) + 1 AS nxt FROM queue WHERE shop = ?", (shop,))
    return int(c.fetchone()["nxt"])

def find_latest_waiting(conn, user_id: str):
    c = conn.cursor()
    c.execute("""
        SELECT * FROM queue
        WHERE user_id = ? AND status = 'waiting'
        ORDER BY id DESC
        LIMIT 1
    """, (user_id,))
    return c.fetchone()

def count_ahead(conn, shop: str, number: int) -> int:
    c = conn.cursor()
    c.execute("""
        SELECT COUNT(*) AS cnt
        FROM queue
        WHERE shop = ? AND status = 'waiting' AND number < ?
    """, (shop, number))
    return int(c.fetchone()["cnt"])

def register(conn, shop: str, user_id: str, name: str, party_size: int) -> int:
    num = next_number(conn, shop)
    c = conn.cursor()
    c.execute("""
        INSERT INTO queue (created_at, shop, user_id, name, party_size, number, status)
        VALUES (?, ?, ?, ?, ?, ?, 'waiting')
    """, (utc_now_iso(), shop, user_id, name, party_size, num))
    conn.commit()
    return num

def cancel(conn, user_id: str) -> bool:
    row = find_latest_waiting(conn, user_id)
    if not row:
        return False
    c = conn.cursor()
    c.execute("""
        UPDATE queue
        SET status='canceled', done_at=?
        WHERE id=?
    """, (utc_now_iso(), int(row["id"])))
    conn.commit()
    return True

def call_number(conn, shop: str, number: int):
    c = conn.cursor()
    c.execute("""
        SELECT * FROM queue
        WHERE shop = ? AND number = ? AND status = 'waiting'
        ORDER BY id DESC
        LIMIT 1
    """, (shop, number))
    row = c.fetchone()
    if not row:
        return None
    c.execute("""
        UPDATE queue
        SET status='called', called_at=?
        WHERE id=?
    """, (utc_now_iso(), int(row["id"])))
    conn.commit()
    return row

# =========================
# Message texts
# =========================
WELCOME = (
    "ようこそ😊「大正町 順番待ち」です。\n\n"
    "送る言葉はこれだけ👇\n"
    "✅ 受付（例：受付 2名 山本鮮魚店 ひとみ）\n"
    "✅ 状況\n"
    "✅ キャンセル\n\n"
    "スタッフ用：呼出 12（必要なら合言葉付き）"
)

HELP = (
    "使い方👇\n\n"
    "・受付：例「受付 2名 山本鮮魚店 ひとみ」\n"
    "・状況：「状況」\n"
    "・キャンセル：「キャンセル」\n\n"
    "スタッフ：『呼出 12』\n"
    "（合言葉を使うなら『呼出 12 合言葉』）"
)

def parse_reception(text: str):
    # 人数： "2名"
    m = re.search(r"(\d+)\s*名", text)
    party_size = int(m.group(1)) if m else 1

    # 店名：雑に拾う（後で選択式も可）
    shop = DEFAULT_SHOP
    if "山本" in text:
        shop = "山本鮮魚店"
    elif "田中" in text:
        shop = "田中鮮魚店"

    # 名前：最後の単語を名前扱い
    cleaned = re.sub(r"受付|順番待ち|登録|\d+\s*名", "", text).strip()
    tokens = [t for t in re.split(r"\s+", cleaned) if t]
    name = tokens[-1] if tokens else ""

    return party_size, shop, name

def admin_ok(text: str) -> bool:
    # ADMIN_PASS が空なら制限なし
    if not ADMIN_PASS:
        return True
    return ADMIN_PASS in text

# =========================
# Routes
# =========================
@app.on_event("startup")
def on_startup():
    init_db()

@app.get("/status")
def status():
    # DBファイルが作れてるかも分かる
    exists = os.path.exists(DB_PATH)
    size = os.path.getsize(DB_PATH) if exists else 0
    return {
        "ok": True,
        "line_env": bool(LINE_CHANNEL_ACCESS_TOKEN and LINE_CHANNEL_SECRET),
        "db_path": DB_PATH,
        "db_exists": exists,
        "db_size": size,
        "webhook": "/webhook/line",
    }

@app.post("/webhook/line")
async def webhook(request: Request):
    signature = request.headers.get("X-Line-Signature", "")
    body = await request.body()
    body_text = body.decode("utf-8")
    try:
        handler.handle(body_text, signature)
    except InvalidSignatureError:
        return JSONResponse({"ok": False, "error": "Invalid signature"}, status_code=400)
    return {"ok": True}

@handler.add(MessageEvent, message=TextMessage)
def handle_message(event: MessageEvent):
    text = (event.message.text or "").strip()
    user_id = event.source.user_id
    t = text.lower()

    # help
    if t in ["help", "ヘルプ", "使い方", "つかいかた"]:
        line_bot_api.reply_message(event.reply_token, TextSendMessage(text=HELP))
        return

    # greeting
    if t in ["こんにちは", "こんちは", "やあ", "hello"]:
        line_bot_api.reply_message(event.reply_token, TextSendMessage(text=WELCOME))
        return

    # staff call: "呼出 12"  or "呼出 12 合言葉"
    if t.startswith("呼出") or t.startswith("呼び出し"):
        if not admin_ok(text):
            line_bot_api.reply_message(event.reply_token, TextSendMessage(text="合言葉が違うみたい🙏"))
            return

        m = re.search(r"(\d+)", text)
        if not m:
            line_bot_api.reply_message(event.reply_token, TextSendMessage(text="呼出の例：呼出 12"))
            return
        number = int(m.group(1))

        try:
            with get_conn() as conn:
                row = call_number(conn, DEFAULT_SHOP, number)
                if not row:
                    line_bot_api.reply_message(event.reply_token, TextSendMessage(text=f"{number}番が見つからない（waitingが無い）"))
                    return

                target_user = row["user_id"]
                # push（呼び出し通知）
                line_bot_api.push_message(
                    target_user,
                    TextSendMessage(text=f"📣順番が来ました！受付番号：{number}\nできれば5分以内にお店の前へ来てね😊\n来れない場合は「キャンセル」と送ってね。")
                )

            line_bot_api.reply_message(event.reply_token, TextSendMessage(text=f"{number}番に呼び出し通知を送りました✅"))
            return
        except Exception as e:
            line_bot_api.reply_message(event.reply_token, TextSendMessage(text=f"呼出エラー：{e}"))
            return

    # reception
    if "受付" in text or "順番待ち" in text or "登録" in text:
        try:
            party_size, shop, name = parse_reception(text)
            with get_conn() as conn:
                num = register(conn, shop, user_id, name, party_size)
                ahead = count_ahead(conn, shop, num)

            msg = (
                "受付できたよ✅\n"
                f"店：{shop}\n"
                f"人数：{party_size}名\n"
                f"受付番号：{num}\n"
                f"あなたより前：{ahead} 人\n\n"
                "呼び出しが近づいたらLINEでお知らせするね📣\n"
                "途中で取り消すなら「キャンセル」って送ってね。"
            )
            line_bot_api.reply_message(event.reply_token, TextSendMessage(text=msg))
            return
        except Exception as e:
            line_bot_api.reply_message(event.reply_token, TextSendMessage(text=f"受付エラー：{e}"))
            return

    # status
    if t in ["状況", "確認", "あと何人", "あとなんにん", "じょうきょう"]:
        try:
            with get_conn() as conn:
                row = find_latest_waiting(conn, user_id)
                if not row:
                    line_bot_api.reply_message(event.reply_token, TextSendMessage(text="まだ受付が見つからないよ🙏\n「受付 2名 山本鮮魚店 ひとみ」みたいに送ってね。"))
                    return
                ahead = count_ahead(conn, row["shop"], int(row["number"]))

            msg = (
                "いまの状況はこちら👇\n"
                f"店：{row['shop']}\n"
                f"あなたの番号：{row['number']}\n"
                f"あなたより前：{ahead} 人\n\n"
                "※混雑状況で前後するよ"
            )
            line_bot_api.reply_message(event.reply_token, TextSendMessage(text=msg))
            return
        except Exception as e:
            line_bot_api.reply_message(event.reply_token, TextSendMessage(text=f"状況エラー：{e}"))
            return

    # cancel
    if t in ["キャンセル", "取り消し", "とりけし", "cancel"]:
        try:
            with get_conn() as conn:
                ok = cancel(conn, user_id)
            if ok:
                line_bot_api.reply_message(event.reply_token, TextSendMessage(text="キャンセルOK✅\nまた必要になったら「受付」と送ってね😊"))
            else:
                line_bot_api.reply_message(event.reply_token, TextSendMessage(text="キャンセル対象が見つからない🙏\n先に「受付」をしてね。"))
            return
        except Exception as e:
            line_bot_api.reply_message(event.reply_token, TextSendMessage(text=f"キャンセルエラー：{e}"))
            return

    # fallback
    line_bot_api.reply_message(event.reply_token, TextSendMessage(text=WELCOME))
