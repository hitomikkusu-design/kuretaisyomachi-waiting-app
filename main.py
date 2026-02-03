import os, json, hmac, hashlib, base64
from datetime import datetime, date
from typing import Optional

import httpx
from fastapi import FastAPI, Request, Header, HTTPException
from fastapi.responses import HTMLResponse, JSONResponse

app = FastAPI()

# ====== ENV ======
LINE_CHANNEL_SECRET = os.getenv("LINE_CHANNEL_SECRET", "")
LINE_CHANNEL_ACCESS_TOKEN = os.getenv("LINE_CHANNEL_ACCESS_TOKEN", "")
LIFF_ID = os.getenv("LIFF_ID", "")
ADMIN_USER_IDS = set([x.strip() for x in os.getenv("ADMIN_USER_IDS", "").split(",") if x.strip()])

STATE_FILE = "/tmp/waiting_state.json"  # デモ用。Render再起動/再デプロイで消える可能性あり


def _today():
    return date.today().isoformat()


def load_state():
    try:
        with open(STATE_FILE, "r", encoding="utf-8") as f:
            s = json.load(f)
    except Exception:
        s = {"date": _today(), "queue": []}  # queue: [{userId,name,party,createdAt}]
    if s.get("date") != _today():
        s = {"date": _today(), "queue": []}
    return s


def save_state(s):
    with open(STATE_FILE, "w", encoding="utf-8") as f:
        json.dump(s, f, ensure_ascii=False, indent=2)


def verify_signature(body: bytes, signature: Optional[str]) -> bool:
    if not LINE_CHANNEL_SECRET or not signature:
        return False
    mac = hmac.new(LINE_CHANNEL_SECRET.encode("utf-8"), body, hashlib.sha256).digest()
    expected = base64.b64encode(mac).decode("utf-8")
    return hmac.compare_digest(expected, signature)


async def line_reply(reply_token: str, text: str):
    if not LINE_CHANNEL_ACCESS_TOKEN:
        return
    url = "https://api.line.me/v2/bot/message/reply"
    headers = {"Authorization": f"Bearer {LINE_CHANNEL_ACCESS_TOKEN}", "Content-Type": "application/json"}
    payload = {"replyToken": reply_token, "messages": [{"type": "text", "text": text}]}
    async with httpx.AsyncClient(timeout=10) as client:
        r = await client.post(url, headers=headers, json=payload)
        if r.status_code >= 300:
            print("reply failed:", r.status_code, r.text)


async def line_push(user_id: str, text: str):
    if not LINE_CHANNEL_ACCESS_TOKEN:
        return
    url = "https://api.line.me/v2/bot/message/push"
    headers = {"Authorization": f"Bearer {LINE_CHANNEL_ACCESS_TOKEN}", "Content-Type": "application/json"}
    payload = {"to": user_id, "messages": [{"type": "text", "text": text}]}
    async with httpx.AsyncClient(timeout=10) as client:
        r = await client.post(url, headers=headers, json=payload)
        if r.status_code >= 300:
            print("push failed:", r.status_code, r.text)


def format_queue(q):
    if not q:
        return "📭 いま待ちリストは空です。"
    lines = ["🧾 現在の待ちリスト"]
    for i, x in enumerate(q, start=1):
        lines.append(f"{i}. {x['name']}（{x['party']}名）")
    return "\n".join(lines)


@app.get("/")
def root():
    return {"message": "waiting app running", "liff": "/liff"}


# ====== LIFF 画面（QRで開く画面）======
@app.get("/liff", response_class=HTMLResponse)
def liff_page():
    # LIFF_ID が空なら画面で教える
    html = f"""
<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>大正町 順番待ち</title>
  <script src="https://static.line-scdn.net/liff/edge/2/sdk.js"></script>
  <style>
    body{{font-family:sans-serif;padding:16px;background:#fafafa}}
    .card{{max-width:520px;background:#fff;border:1px solid #eee;border-radius:14px;padding:16px}}
    input{{width:100%;padding:12px;border-radius:12px;border:1px solid #ccc;margin-top:6px}}
    button{{width:100%;padding:12px;border:0;border-radius:12px;margin-top:12px;cursor:pointer}}
    .muted{{color:#666;font-size:13px}}
    .ok{{color:#0a7}}
    .ng{{color:#c00}}
  </style>
</head>
<body>
  <div class="card">
    <h2>大正町 順番待ち</h2>
    <p id="status" class="muted">初期化中...</p>

    <div style="margin-top:10px">
      <label>お名前</label>
      <input id="name" placeholder="例：山本">
    </div>

    <div style="margin-top:10px">
      <label>人数</label>
      <input id="party" type="number" min="1" value="1">
    </div>

    <button onclick="register()">受付する</button>
    <p id="result" class="muted" style="margin-top:12px"></p>
  </div>

<script>
const LIFF_ID = "{LIFF_ID}";

async function init() {{
  const status = document.getElementById("status");
  if (!LIFF_ID) {{
    status.className="muted ng";
    status.innerText="LIFF_IDが未設定です。RenderのEnvironmentに LIFF_ID を入れてください。";
    return;
  }}

  try {{
    await liff.init({{ liffId: LIFF_ID }});
    if (!liff.isLoggedIn()) {{
      status.innerText="LINEログインへ移動します...";
      liff.login();
      return;
    }}
    const profile = await liff.getProfile();
    document.getElementById("name").value = profile.displayName || "";
    status.className="muted ok";
    status.innerText="ログインOK：" + (profile.displayName || "");
  }} catch(e) {{
    status.className="muted ng";
    status.innerText="LIFF初期化エラー：" + e;
    console.error(e);
  }}
}}

async function register() {{
  const result = document.getElementById("result");
  result.className="muted";
  result.innerText="送信中...";

  const name = (document.getElementById("name").value || "").trim();
  const party = parseInt(document.getElementById("party").value || "1", 10);

  if (!name) {{
    result.className="muted ng";
    result.innerText="お名前を入れてね。";
    return;
  }}
  if (!party || party < 1) {{
    result.className="muted ng";
    result.innerText="人数は1以上でお願いします。";
    return;
  }}

  try {{
    const profile = await liff.getProfile();
    const userId = profile.userId;

    const r = await fetch("/api/register", {{
      method:"POST",
      headers:{{"Content-Type":"application/json"}},
      body: JSON.stringify({{ userId, name, party }})
    }});
    const data = await r.json();

    if (data.ok) {{
      result.className="muted ok";
      result.innerText = "受付完了！ あなたは " + data.position + " 番目です。\\nLINEにも受付完了が届きます。";
    }} else {{
      result.className="muted ng";
      result.innerText = data.error || "失敗しました";
    }}
  }} catch(e) {{
    result.className="muted ng";
    result.innerText="エラー：" + e;
  }}
}}

init();
</script>
</body>
</html>
"""
    return html


# ====== 受付登録API（LIFFから叩く）======
@app.post("/api/register")
async def api_register(request: Request):
    body = await request.json()
    user_id = (body.get("userId") or "").strip()
    name = (body.get("name") or "").strip()
    party = int(body.get("party") or 1)

    if not user_id or not name or party < 1:
        return JSONResponse({"ok": False, "error": "入力が不正です"})

    s = load_state()
    q = s["queue"]

    # すでに登録済みなら位置を返す
    for idx, x in enumerate(q, start=1):
        if x["userId"] == user_id:
            await line_push(user_id, f"受付済みです：{x['name']}（{x['party']}名）\nあなたは {idx} 番目です。")
            return JSONResponse({"ok": True, "position": idx})

    q.append({
        "userId": user_id,
        "name": name,
        "party": party,
        "createdAt": datetime.now().isoformat(timespec="seconds")
    })
    s["queue"] = q
    save_state(s)

    position = len(q)
    await line_push(user_id, f"✅ 受付完了！\n{name}（{party}名）\nあなたは {position} 番目です。\n呼び出しが来るまでお待ちください。")
    return JSONResponse({"ok": True, "position": position})


# ====== LINE Webhook（管理者コマンド）======
@app.post("/callback")
async def callback(request: Request, x_line_signature: str = Header(default="", alias="X-Line-Signature")):
    raw = await request.body()
    if not verify_signature(raw, x_line_signature):
        raise HTTPException(status_code=400, detail="Bad signature")

    data = json.loads(raw.decode("utf-8"))
    events = data.get("events", [])
    s = load_state()

    for ev in events:
        if ev.get("type") != "message":
            continue
        msg = ev.get("message", {})
        if msg.get("type") != "text":
            continue

        text = (msg.get("text") or "").strip()
        reply_token = ev.get("replyToken", "")
        user_id = (ev.get("source") or {}).get("userId", "")

        # 非管理者には案内だけ（必要なら無言でもOK）
        if user_id not in ADMIN_USER_IDS:
            await line_reply(reply_token, "受付はQRからお願いします🙏")
            continue

        q = s["queue"]

        if text in ["ヘルプ", "help", "？", "?"]:
            await line_reply(reply_token,
                "【管理コマンド】\n"
                "一覧 / 次 / 完了 / クリア\n"
                "（呼び出しは「次」）"
            )
            continue

        if text in ["一覧", "list"]:
            await line_reply(reply_token, format_queue(q))
            continue

        if text in ["クリア", "clear", "リセット"]:
            s = {"date": _today(), "queue": []}
            save_state(s)
            await line_reply(reply_token, "🧹 全消ししました。")
            continue

        if text in ["次", "つぎ", "next"]:
            if not q:
                await line_reply(reply_token, "📭 待ちはゼロです。")
                continue
            first = q[0]
            await line_push(first["userId"], f"📣 呼び出しです！\n{first['name']}（{first['party']}名）\nカウンターまでお願いします。")
            await line_reply(reply_token, f"呼び出し送信：{first['name']}（{first['party']}名）\n（完了したら「完了」）")
            continue

        if text in ["完了", "done", "削除"]:
            if not q:
                await line_reply(reply_token, "📭 待ちはゼロです。")
                continue
            done_item = q.pop(0)
            s["queue"] = q
            save_state(s)
            await line_reply(reply_token, f"✅ 完了：{done_item['name']}（{done_item['party']}名）\n\n" + format_queue(q))
            continue

        await line_reply(reply_token, "コマンド不明。『ヘルプ』をどうぞ。")

    return {"status": "ok"}
