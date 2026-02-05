import os
import sqlite3
from datetime import datetime
from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, JSONResponse
from linebot import LineBotApi, WebhookHandler
from linebot.exceptions import InvalidSignatureError
from linebot.models import MessageEvent, TextMessage, TextSendMessage

# ========= ENV =========
LINE_CHANNEL_ACCESS_TOKEN = os.getenv("LINE_CHANNEL_ACCESS_TOKEN", "")
LINE_CHANNEL_SECRET = os.getenv("LINE_CHANNEL_SECRET", "")
LIFF_ID = os.getenv("LIFF_ID", "")  # ★ LINE DevelopersのLIFF IDをここに入れる
ADMIN_PASS = os.getenv("ADMIN_PASS", "")  # 例：taisho123

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
        number INTEGER NOT NULL,
        shop TEXT NOT NULL,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        phone TEXT NOT NULL,
        party_size INTEGER NOT NULL,
        status TEXT NOT NULL,        -- waiting/called/canceled/done
        created_at TEXT NOT NULL,
        called_at TEXT
    )
    """)
    conn.commit()
    conn.close()

def get_conn():
    return sqlite3.connect(DB_PATH)

def next_number():
    conn = get_conn()
    c = conn.cursor()
    c.execute("SELECT COALESCE(MAX(number), 0) + 1 FROM queue WHERE shop=?", (SHOP_NAME,))
    n = int(c.fetchone()[0])
    conn.close()
    return n

def count_ahead(number: int) -> int:
    conn = get_conn()
    c = conn.cursor()
    c.execute("SELECT COUNT(*) FROM queue WHERE shop=? AND status='waiting' AND number < ?", (SHOP_NAME, number))
    ahead = int(c.fetchone()[0])
    conn.close()
    return ahead

def register(user_id: str, name: str, phone: str, party_size: int) -> int:
    num = next_number()
    conn = get_conn()
    c = conn.cursor()
    c.execute("""
        INSERT INTO queue (number, shop, user_id, name, phone, party_size, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 'waiting', ?)
    """, (num, SHOP_NAME, user_id, name, phone, party_size, datetime.now().isoformat()))
    conn.commit()
    conn.close()
    return num

def call_number(number: int):
    conn = get_conn()
    c = conn.cursor()
    c.execute("""
        SELECT user_id, name, phone, party_size FROM queue
        WHERE shop=? AND number=? AND status='waiting'
        ORDER BY id DESC LIMIT 1
    """, (SHOP_NAME, number))
    row = c.fetchone()
    if not row:
        conn.close()
        return None

    c.execute("UPDATE queue SET status='called', called_at=? WHERE shop=? AND number=? AND status='waiting'",
              (datetime.now().isoformat(), SHOP_NAME, number))
    conn.commit()
    conn.close()
    return {
        "user_id": row[0],
        "name": row[1],
        "phone": row[2],
        "party_size": row[3]
    }

def cancel_latest(user_id: str) -> bool:
    conn = get_conn()
    c = conn.cursor()
    c.execute("""
        SELECT id FROM queue
        WHERE user_id=? AND shop=? AND status='waiting'
        ORDER BY id DESC LIMIT 1
    """, (user_id, SHOP_NAME))
    row = c.fetchone()
    if not row:
        conn.close()
        return False
    qid = int(row[0])
    c.execute("UPDATE queue SET status='canceled' WHERE id=?", (qid,))
    conn.commit()
    conn.close()
    return True

def user_status(user_id: str):
    conn = get_conn()
    c = conn.cursor()
    c.execute("""
        SELECT number, party_size FROM queue
        WHERE user_id=? AND shop=? AND status='waiting'
        ORDER BY id DESC LIMIT 1
    """, (user_id, SHOP_NAME))
    row = c.fetchone()
    if not row:
        conn.close()
        return None
    number = int(row[0])
    party_size = int(row[1])
    ahead = count_ahead(number)
    conn.close()
    return {"number": number, "ahead": ahead, "party_size": party_size}

init_db()

# ========= Pages =========
@app.get("/status")
def status():
    return {"ok": True, "shop": SHOP_NAME}

@app.get("/liff", response_class=HTMLResponse)
def liff_page():
    # 名前 / 人数タブ / 電話 だけ。文字コマンド不要。
    return f"""<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>{SHOP_NAME} 受付</title>
  <script src="https://static.line-scdn.net/liff/edge/2/sdk.js"></script>
  <style>
    body{{font-family:system-ui,-apple-system,Segoe UI,Roboto,'Noto Sans JP',sans-serif;background:#f6f7f8;margin:0;padding:16px;}}
    .card{{background:#fff;border-radius:14px;padding:16px;box-shadow:0 6px 20px rgba(0,0,0,.06);max-width:520px;margin:0 auto;}}
    h1{{font-size:18px;margin:0 0 12px;}}
    label{{display:block;font-size:13px;margin:12px 0 6px;}}
    input{{width:100%;padding:12px;border:1px solid #ddd;border-radius:10px;font-size:16px;}}
    .row{{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;}}
    .btn{{flex:1;min-width:72px;padding:12px;border-radius:10px;border:1px solid #ddd;background:#fff;font-size:16px;}}
    .btn.active{{border-color:#111;}}
    .primary{{width:100%;margin-top:14px;padding:14px;border:0;border-radius:12px;background:#111;color:#fff;font-size:16px;}}
    .note{{font-size:12px;color:#666;margin-top:10px;line-height:1.5;}}
    .ok{{margin-top:12px;padding:12px;border-radius:12px;background:#f0fff4;border:1px solid #bfe7c7;}}
    .err{{margin-top:12px;padding:12px;border-radius:12px;background:#fff3f3;border:1px solid #f0b4b4;}}
  </style>
</head>
<body>
  <div class="card">
    <h1>【{SHOP_NAME}】順番待ち 受付</h1>

    <label>お名前</label>
    <input id="name" placeholder="例：ひとみ" />

    <label>人数（タブを押して選ぶ）</label>
    <div class="row" id="partyRow"></div>

    <label>電話番号</label>
    <input id="phone" inputmode="numeric" placeholder="例：09012345678" />

    <button class="primary" id="submit">受付する</button>

    <div class="note">
      ※入力は「名前・人数・電話番号」だけでOK。<br/>
      ※受付後はLINEで呼出し通知が届くきね。
    </div>

    <div id="msg"></div>
  </div>

<script>
  const LIFF_ID = "{LIFF_ID}";
  let partySize = 2;

  function renderPartyButtons() {{
    const row = document.getElementById("partyRow");
    row.innerHTML = "";
    [1,2,3,4,5,6].forEach(n => {{
      const b = document.createElement("button");
      b.className = "btn" + (n===partySize ? " active" : "");
      b.type = "button";
      b.textContent = n + "名";
      b.onclick = () => {{
        partySize = n;
        renderPartyButtons();
      }};
      row.appendChild(b);
    }});
  }}

  function setMsg(html, ok=true) {{
    const d = document.getElementById("msg");
    d.innerHTML = `<div class="${{ok?'ok':'err'}}">${{html}}</div>`;
  }}

  async function main() {{
    renderPartyButtons();

    try {{
      await liff.init({{ liffId: LIFF_ID }});
      if (!liff.isLoggedIn()) {{
        liff.login();
        return;
      }}
    }} catch (e) {{
      setMsg("LIFFの初期化に失敗したき。LIFF IDの設定を確認してね。", false);
      return;
    }}

    document.getElementById("submit").onclick = async () => {{
      const name = (document.getElementById("name").value || "").trim();
      const phone = (document.getElementById("phone").value || "").trim();

      if (!name) return setMsg("お名前を入れてつかあさい。", false);
      if (!phone.match(/^0\\d{{9,10}}$/)) return setMsg("電話番号は数字だけ（例：09012345678）で入れてつかあさい。", false);

      const prof = await liff.getProfile();
      const userId = prof.userId;

      const res = await fetch("/api/register", {{
        method: "POST",
        headers: {{ "Content-Type": "application/json" }},
        body: JSON.stringify({{ user_id: userId, name, phone, party_size: partySize }})
      }});

      const data = await res.json();
      if (!data.ok) {{
        setMsg(data.error || "受付に失敗したき。", false);
        return;
      }}

      setMsg(`受付できたで😊<br/><b>番号：${{data.number}}</b><br/>あと：${{data.ahead}}組ばあ`);
      // 受付後は閉じてもOK
    }};
  }}

  main();
</script>
</body>
</html>
"""

# ========= API =========
@app.post("/api/register")
async def api_register(payload: dict):
    user_id = (payload.get("user_id") or "").strip()
    name = (payload.get("name") or "").strip()
    phone = (payload.get("phone") or "").strip()
    party_size = int(payload.get("party_size") or 0)

    if not user_id:
        return {"ok": False, "error": "user_idが取れんかったき。"}
    if not name:
        return {"ok": False, "error": "名前を入れてつかあさい。"}
    if party_size <= 0:
        return {"ok": False, "error": "人数を選んでつかあさい。"}
    if not phone.isdigit() or not (10 <= len(phone) <= 11) or not phone.startswith("0"):
        return {"ok": False, "error": "電話番号は数字だけ（10〜11桁）で入れてつかあさい。"}

    number = register(user_id, name, phone, party_size)
    ahead = count_ahead(number)

    # 受付完了をLINEにpush（フォーム受付でも必ずLINEに返す）
    line_bot_api.push_message(
        user_id,
        TextSendMessage(
            text=(
                f"【受付完了｜{SHOP_NAME}】\n\n"
                f"番号：{number}\n"
                f"人数：{party_size}名\n"
                f"今のところ、あと{ahead}組ばあ\n\n"
                "順番になったらLINEで呼ぶきね。\n"
                "店の前で待たんでえいで。"
            )
        )
    )

    return {"ok": True, "number": number, "ahead": ahead}

# ========= LINE Webhook =========
@app.post("/webhook/line")
async def webhook(request: Request):
    signature = request.headers.get("X-Line-Signature", "")
    body = await request.body()
    try:
        handler.handle(body.decode("utf-8"), signature)
    except InvalidSignatureError:
        return JSONResponse({"ok": False, "error": "Invalid signature"}, status_code=400)
    return {"ok": True}

@handler.add(MessageEvent, message=TextMessage)
def handle_message(event: MessageEvent):
    text = (event.message.text or "").strip()
    user_id = event.source.user_id

    # スタッフ：呼出 12 合言葉
    if text.startswith("呼出"):
        if ADMIN_PASS and ADMIN_PASS not in text:
            line_bot_api.reply_message(event.reply_token, TextSendMessage(text="合言葉が違うき。"))
            return

        import re
        m = re.search(r"(\\d+)", text)
        if not m:
            line_bot_api.reply_message(event.reply_token, TextSendMessage(text="例：呼出 12 合言葉"))
            return

        number = int(m.group(1))
        row = call_number(number)
        if not row:
            line_bot_api.reply_message(event.reply_token, TextSendMessage(text=f"{number}番はおらんき。"))
            return

        # お客さんへ呼出し
        line_bot_api.push_message(
            row["user_id"],
            TextSendMessage(
                text=(
                    f"📣【呼出し｜{SHOP_NAME}】\n"
                    f"{number}番のお客さん（{row['party_size']}名）\n\n"
                    "順番きたき。\n"
                    "5分以内に店の前まで来てつかあさい。\n\n"
                    "遅れる時は「遅れる」\n"
                    "来れん時は「キャンセル」って送って。"
                )
            )
        )
        line_bot_api.reply_message(event.reply_token, TextSendMessage(text=f"呼出したで：{number}"))
        return

    # お客さん：状況
    if text in ["状況", "確認"]:
        st = user_status(user_id)
        if not st:
            line_bot_api.reply_message(
                event.reply_token,
                TextSendMessage(
                    text=(
                        f"まだ受付しちょらんき。\n"
                        f"受付はこの画面からお願いね👇\n"
                        f"https://liff.line.me/{LIFF_ID}"
                    )
                )
            )
            return
        line_bot_api.reply_message(
            event.reply_token,
            TextSendMessage(
                text=(
                    f"【順番状況｜{SHOP_NAME}】\n\n"
                    f"番号：{st['number']}\n"
                    f"人数：{st['party_size']}名\n"
                    f"今のところ、あと{st['ahead']}組ばあ\n\n"
                    "順番になったらLINEで呼ぶきね。"
                )
            )
        )
        return

    # お客さん：キャンセル
    if text in ["キャンセル", "取り消し", "とりけし"]:
        ok = cancel_latest(user_id)
        if ok:
            line_bot_api.reply_message(event.reply_token, TextSendMessage(text="キャンセル受けたき。ありがとうね。"))
        else:
            line_bot_api.reply_message(event.reply_token, TextSendMessage(text="キャンセル対象が見つからんき。"))
        return

    # その他：受付はLIFFへ誘導（文字を打たせない）
    line_bot_api.reply_message(
        event.reply_token,
        TextSendMessage(
            text=(
                f"受付はここからお願いね👇\n"
                f"https://liff.line.me/{LIFF_ID}\n\n"
                "（名前・人数・電話番号 入れるだけで終わるき）\n"
                "スタッフは「呼出 番号 合言葉」やき。"
            )
        )
    )
