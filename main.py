import os
import hmac
import hashlib
import base64
import json

from fastapi import FastAPI, Request, Header, HTTPException
from fastapi.responses import HTMLResponse, JSONResponse
import httpx

app = FastAPI()

# ===== 環境変数（RenderのEnvironmentに入れる）=====
LINE_CHANNEL_SECRET = os.getenv("LINE_CHANNEL_SECRET", "")
LINE_CHANNEL_ACCESS_TOKEN = os.getenv("LINE_CHANNEL_ACCESS_TOKEN", "")

# ===== 署名検証（LINEからのWebhookが本物かチェック）=====
def verify_signature(body: bytes, x_line_signature: str | None) -> bool:
    if not LINE_CHANNEL_SECRET:
        # secret未設定なら検証できない（本番は必ず設定してね）
        return False
    if not x_line_signature:
        return False

    hash_ = hmac.new(
        LINE_CHANNEL_SECRET.encode("utf-8"),
        body,
        hashlib.sha256
    ).digest()
    signature = base64.b64encode(hash_).decode("utf-8")
    return hmac.compare_digest(signature, x_line_signature)


# ===== 動作確認用：トップ =====
@app.get("/")
def read_root():
    return {"message": "Kuretaisoyomachi waiting app is running!"}


# ===== Webhook（LINEがここにPOSTしてくる）=====
@app.post("/callback")
async def callback(
    request: Request,
    x_line_signature: str | None = Header(default=None, alias="X-Line-Signature")
):
    body = await request.body()

    # 署名検証
    if not verify_signature(body, x_line_signature):
        raise HTTPException(status_code=400, detail="Invalid signature or secret not set")

    # JSONとして読む
    try:
        payload = json.loads(body.decode("utf-8"))
    except Exception:
        return JSONResponse({"status": "ok", "note": "received but not json"}, status_code=200)

    # 受信ログ（Render Logsに出る）
    print("=== LINE WEBHOOK RECEIVED ===")
    print(json.dumps(payload, ensure_ascii=False, indent=2))

    # 返信（オウム返し）※友だちからのメッセージだけに反応
    events = payload.get("events", [])
    for ev in events:
        if ev.get("type") != "message":
            continue

        msg = ev.get("message", {})
        if msg.get("type") != "text":
            continue

        reply_token = ev.get("replyToken")
        user_text = msg.get("text", "")

        # アクセストークンないと返信できない
        if not LINE_CHANNEL_ACCESS_TOKEN:
            print("LINE_CHANNEL_ACCESS_TOKEN is missing. Cannot reply.")
            continue

        await reply_message(reply_token, f"【大正町 順番待ち】\n{user_text}")

    return {"status": "ok"}


async def reply_message(reply_token: str, text: str):
    url = "https://api.line.me/v2/bot/message/reply"
    headers = {
        "Authorization": f"Bearer {LINE_CHANNEL_ACCESS_TOKEN}",
        "Content-Type": "application/json",
    }
    data = {
        "replyToken": reply_token,
        "messages": [{"type": "text", "text": text}],
    }

    async with httpx.AsyncClient(timeout=10.0) as client:
        r = await client.post(url, headers=headers, json=data)
        print("Reply status:", r.status_code, r.text)


# ===== LIFF 用の画面（これが「画面ルート」）=====
@app.get("/liff", response_class=HTMLResponse)
def liff_page():
    # ここに LIFF_ID を Renderの環境変数で入れる想定（なければプレースホルダ表示）
    liff_id = os.getenv("LIFF_ID", "")

    html = f"""
<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>大正町 順番待ち</title>
  <script src="https://static.line-scdn.net/liff/edge/2/sdk.js"></script>
  <style>
    body {{ font-family: sans-serif; padding: 16px; }}
    .box {{ border: 1px solid #ddd; border-radius: 12px; padding: 16px; max-width: 520px; }}
    button {{ padding: 10px 14px; border-radius: 10px; border: none; cursor: pointer; }}
    input {{ width: 100%; padding: 10px; border-radius: 10px; border: 1px solid #ccc; }}
    .muted {{ color: #666; font-size: 13px; }}
  </style>
</head>
<body>
  <div class="box">
    <h2>大正町 順番待ち</h2>
    <p id="status" class="muted">初期化中...</p>

    <div style="margin:12px 0;">
      <label>お名前（表示用）</label>
      <input id="name" placeholder="例：ひとみ">
    </div>

    <button onclick="send()">送信（テスト）</button>

    <p class="muted" style="margin-top:12px;">
      LIFF_ID: <span id="liffid">{liff_id if liff_id else "（未設定）"}</span>
    </p>
  </div>

<script>
  const LIFF_ID = "{liff_id}";

  async function init() {{
    const status = document.getElementById("status");

    if (!LIFF_ID) {{
      status.innerText = "LIFF_ID が未設定です。RenderのEnvironmentに LIFF_ID を追加してね。";
      return;
    }}

    try {{
      await liff.init({{ liffId: LIFF_ID }});
      if (!liff.isLoggedIn()) {{
        status.innerText = "LINEログインへ移動します...";
        liff.login();
        return;
      }}

      const profile = await liff.getProfile();
      document.getElementById("name").value = profile.displayName || "";
      status.innerText = "ログインOK：" + (profile.displayName || "ユーザー");
    }} catch (e) {{
      status.innerText = "LIFF初期化エラー：" + e;
      console.error(e);
    }}
  }}

  async function send() {{
    const name = document.getElementById("name").value || "（未入力）";
    alert("テスト送信：" + name + "\\n※本実装は次のステップで作る");
  }}

  init();
</script>

</body>
</html>
"""
    return html
