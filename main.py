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

@app.get("/liff", response_class=HTMLResponse)
def web_form():
    # ※ LIFFじゃない。普通のWebフォーム（ログイン不要）
    return f"""<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>{SHOP_NAME} 受付</title>
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
    .note{{font-size:12px;color:#666;margin-top:10px;line-height:1.55;}}
    .ok{{margin-top:12px;padding:12px;border-radius:12px;background:#f0fff4;border:1px solid #bfe7c7;}}
    .err{{margin-top:12px;padding:12px;border-radius:12px;background:#fff3f3;border:1px solid #f0b4b4;}}
    code{{background:#f2f2f2;padding:2px 6px;border-radius:8px;}}
  </style>
</head>
<body>
  <div class="card">
    <h1>【{SHOP_NAME}】順番待ち 受付</h1>

    <label>お名前</label>
    <input id="name" placeholder="例：ひとみ"/>

    <label>人数（タブを押して選ぶ）</label>
    <div class="row" id="partyRow"></div>

    <label>電話番号</label>
    <input id="phone" inputmode="numeric" placeholder="例：09012345678"/>

    <button class="primary" id="submit">受付する</button>

    <div class="note">
      ✅ これはログイン不要の受付フォームやき、Androidでもそのまま使えるで。<br/>
      📣 LINEで呼出し通知が欲しい人は、受付後に出る「連携コード」をLINEに送ってね。
    </div>

    <div id="msg"></div>
  </div>

<script>
  let partySize = 2;

  function renderPartyButtons(){{
    const row = document.getElementById("partyRow");
    row.innerHTML = "";
    [1,2,3,4,5,6].forEach(n => {{
      const b = document.createElement("button");
      b.className = "btn" + (n===partySize ? " active" : "");
      b.type = "button";
      b.textContent = n + "名";
      b.onclick = () => {{ partySize = n; renderPartyButtons(); }};
      row.appendChild(b);
    }});
  }}

  function setMsg(html, ok=true){{
    const d = document.getElementById("msg");
    d.innerHTML = `<div class="${{ok?'ok':'err'}}">${{html}}</div>`;
  }}

  renderPartyButtons();

  document.getElementById("submit").onclick = async () => {{
    const name = (document.getElementById("name").value || "").trim();
    const phone = (document.getElementById("phone").value || "").trim();

    if(!name) return setMsg("お名前を入れてつかあさい。", false);
    if(!phone.match(/^0\\d{{9,10}}$/)) return setMsg("電話番号は数字だけ（例：09012345678）で入れてつかあさい。", false);

    const res = await fetch("/api/register", {{
      method: "POST",
      headers: {{ "Content-Type": "application/json" }},
      body: JSON.stringify({{ name, phone, party_size: partySize }})
    }});
    const data = await res.json();
    if(!data.ok) return setMsg(data.error || "受付に失敗したき。", false);

    setMsg(
      `受付できたで😊<br/>
       <b>番号：${{data.number}}</b>（${{data.party_size}}名）<br/>
       あと：${{data.ahead}}組ばあ<br/><br/>
       📣 LINEで呼出し通知が欲しい人は、友だち追加して<br/>
       <code>連携 ${{data.link_code}}</code><br/>
       って送ってね。`,
      true
    );
  }};
</script>
</body>
</html>
"""

@app.post("/api/register")
async def api_register(payload: dict):
    name = (payload.get("name") or "").strip()
    phone = (payload.get("phone") or "").strip()
    party_size = int(payload.get("party_size") or 0)

    if not name:
        return {"ok": False, "error": "名前を入れてつかあさい。"}
    if party_size <= 0:
        return {"ok": False, "error": "人数を選んでつかあさい。"}
    if not phone.isdigit() or not (10 <= len(phone) <= 11) or not phone.startswith("0"):
        return {"ok": False, "error": "電話番号は数字だけ（10〜11桁）で入れてつかあさい。"}

    result = register_web(SHOP_NAME, name, phone, party_size)
    return {
        "ok": True,
        "shop": SHOP_NAME,
        "number": result["number"],
        "ahead": result["ahead"],
        "party_size": party_size,
        "link_code": result["link_code"]
    }

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

    # ===== 連携（お客）: 連携 123456
    if text.startswith("連携"):
        m = re.search(r"(\\d{6})", text)
        if not m:
            line_bot_api.reply_message(
                event.reply_token,
                TextSendMessage(text="例：連携 123456 って送ってつかあさい。")
            )
            return
        code = m.group(1)
        res = link_line_user(SHOP_NAME, code, user_id)
        if not res["ok"]:
            line_bot_api.reply_message(event.reply_token, TextSendMessage(text=res["error"]))
            return

        line_bot_api.reply_message(
            event.reply_token,
            TextSendMessage(
                text=(
                    f"連携できたで😊\n\n"
                    f"【{SHOP_NAME}】\n"
                    f"番号：{res['number']}（{res['party_size']}名）\n"
                    f"今のところ、あと{res['ahead']}組ばあ\n\n"
                    "順番になったらLINEで呼ぶきね。"
                )
            )
        )
        return

    # ===== 状況（お客）
    if text in ["状況", "確認"]:
        st = get_latest_waiting_by_line(SHOP_NAME, user_id)
        if not st:
            line_bot_api.reply_message(
                event.reply_token,
                TextSendMessage(
                    text=(
                        "まだ連携できちょらんか、受付が見つからんき。\n"
                        "受付後に出るコードを\n"
                        "「連携 123456」って送ってね。"
                    )
                )
            )
            return
        line_bot_api.reply_message(
            event.reply_token,
            TextSendMessage(
                text=(
                    f"【順番状況｜{SHOP_NAME}】\n\n"
                    f"番号：{st['number']}（{st['party_size']}名）\n"
                    f"今のところ、あと{st['ahead']}組ばあ\n\n"
                    "順番になったらLINEで呼ぶきね。"
                )
            )
        )
        return

    # ===== キャンセル（お客）
    if text in ["キャンセル", "取り消し", "とりけし"]:
        ok = cancel_latest_by_line(SHOP_NAME, user_id)
        if ok:
            line_bot_api.reply_message(event.reply_token, TextSendMessage(text="キャンセル受けたき。ありがとうね。"))
        else:
            line_bot_api.reply_message(
                event.reply_token,
                TextSendMessage(text="キャンセルできる受付が見つからんき。連携してない人は電話で言うてね。")
            )
        return

    # ===== スタッフ：呼出 番号 合言葉
    if text.startswith("呼出"):
        if ADMIN_PASS and ADMIN_PASS not in text:
            line_bot_api.reply_message(event.reply_token, TextSendMessage(text="合言葉が違うき。"))
            return

        m = re.search(r"(\\d+)", text)
        if not m:
            line_bot_api.reply_message(event.reply_token, TextSendMessage(text="例：呼出 12 合言葉"))
            return

        number = int(m.group(1))
        info = call_number(SHOP_NAME, number)
        if not info:
            line_bot_api.reply_message(event.reply_token, TextSendMessage(text=f"{number}番はおらんき。"))
            return

        # LINE連携済みなら通知、未連携なら電話番号を返す
        if info["line_user_id"]:
            line_bot_api.push_message(
                info["line_user_id"],
                TextSendMessage(
                    text=(
                        f"📣【呼出し｜{SHOP_NAME}】\n"
                        f"{number}番のお客さん（{info['party_size']}名）\n\n"
                        "順番きたき。\n"
                        "5分以内に店の前まで来てつかあさい。\n\n"
                        "遅れる時は「遅れる」\n"
                        "来れん時は「キャンセル」って送って。"
                    )
                )
            )
            line_bot_api.reply_message(event.reply_token, TextSendMessage(text=f"呼出したで：{number}（LINE通知済）"))
        else:
            line_bot_api.reply_message(
                event.reply_token,
                TextSendMessage(
                    text=(
                        f"呼出対象：{number}番（{info['party_size']}名）\n"
                        f"名前：{info['name']}\n"
                        f"電話：{info['phone']}\n\n"
                        "※この人はLINE未連携やき、電話で呼んでね。"
                    )
                )
            )
        return

    # その他：受付URL案内
    line_bot_api.reply_message(
        event.reply_token,
        TextSendMessage(
            text=(
                f"受付はここからお願いね👇\n"
                f"https://kuretaisyomachi-waiting-app.onrender.com/liff\n\n"
                "受付後に出る6桁コードを\n"
                "「連携 123456」って送ったら、呼出しがLINEで届くき。"
            )
        )
    )
