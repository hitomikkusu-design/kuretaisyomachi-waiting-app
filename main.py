from fastapi import FastAPI, Request, Header
from fastapi.responses import HTMLResponse, JSONResponse
import os
import hmac
import hashlib
import base64
import json
import httpx

app = FastAPI()

# ===== 環境変数（RenderのEnvironmentに入れる）=====
LINE_CHANNEL_SECRET = os.getenv("LINE_CHANNEL_SECRET", "")
LINE_CHANNEL_ACCESS_TOKEN = os.getenv("LINE_CHANNEL_ACCESS_TOKEN", "")
LIFF_ID = os.getenv("LIFF_ID", "")  # 例: 2009xxxxxx-xxxxxxxx  ※ここは「数字とハイフンのみ」

# ===== 署名検証 =====
def verify_signature(body: bytes, signature: str) -> bool:
    if not LINE_CHANNEL_SECRET or not signature:
        return False
    mac = hmac.new(LINE_CHANNEL_SECRET.encode("utf-8"), body, hashlib.sha256).digest()
    expected = base64.b64encode(mac).decode("utf-8")
    return hmac.compare_digest(expected, signature)

# ===== LINEに返信 =====
async def reply_message(reply_token: str, text: str):
    if not LINE_CHANNEL_ACCESS_TOKEN:
        print("LINE_CHANNEL_ACCESS_TOKEN is missing")
        return

    url = "https://api.line.me/v2/bot/message/reply"
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {LINE_CHANNEL_ACCESS_TOKEN}",
    }
    payload = {
        "replyToken": reply_token,
        "messages": [{"type": "text", "text": text}],
    }

    async with httpx.AsyncClient(timeout=10) as client:
        r = await client.post(url, headers=headers, json=payload)
        if r.status_code != 200:
            print("Reply failed:", r.status_code, r.text)

# ===== 動作確認 =====
@app.get("/", response_class=JSONResponse)
async def root():
    return {"message": "kuretaisyo-machi waiting app is running!"}

# ===== Webhook（LINE Developersで /callback を設定する）=====
@app.post("/callback")
async def callback(request: Request, x_line_signature: str = Header(default="")):
    body = await request.body()

    # 署名チェック（これが通らないとLINEは弾く）
    if not verify_signature(body, x_line_signature):
        return JSONResponse({"error": "Invalid signature"}, status_code=400)

    data = json.loads(body.decode("utf-8"))

    # events からメッセージを拾って返信
    events = data.get("events", [])
    for event in events:
        if event.get("type") == "message":
            msg = event.get("message", {})
            if msg.get("type") == "text":
                user_text = msg.get("text", "")
                reply_token = event.get("replyToken")
                if reply_token:
                    # ここが「オウム返し」
                    await reply_message(reply_token, f"受け取ったで：{user_text}")

    return {"status": "ok"}

# ===== LIFF画面（LINE Developersで エンドポイントURL に /liff を入れる）=====
@app.get("/liff", response_class=HTMLResponse)
async def liff_page():
    # ここで LIFF_ID を JS に渡す（JS側では必ず " " で囲む）
    safe_liff_id = LIFF_ID or ""

    html = f"""
<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>大正町 順番待ち</title>
  <script src="https://static.line-scdn.net/liff/edge/2/sdk.js"></script>
  <style>
    body {{
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Noto Sans JP", "Hiragino Sans", "Yu Gothic", sans-serif;
      padding: 16px;
    }}
    .card {{
      max-width: 560px;
      margin: 0 auto;
      padding: 16px;
      border: 1px solid #eee;
      border-radius: 12px;
    }}
    .title {{
      font-size: 20px;
      font-weight: 700;
      margin: 0 0 8px;
    }}
    .muted {{
      color: #666;
      font-size: 13px;
      margin: 0 0 12px;
    }}
    button {{
      width: 100%;
      padding: 12px;
      border: 0;
      border-radius: 10px;
      font-size: 16px;
      cursor: pointer;
    }}
    #status {{
      margin-top: 12px;
      font-size: 14px;
      color: #333;
      white-space: pre-wrap;
    }}
    .danger {{
      color: #b00020;
      font-size: 13px;
      margin-top: 8px;
    }}
    input {{
      width: 100%;
      padding: 10px;
      margin-top: 10px;
      border: 1px solid #ddd;
      border-radius: 10px;
      font-size: 16px;
    }}
  </style>
</head>
<body>
  <div class="card">
    <p class="title">大正町 順番待ち</p>
    <p class="muted">LIFFでログイン情報を読み込みます。</p>

    <button id="btn" onclick="sendToChat()">この内容をLINEチャットへ送る</button>
    <input id="msg" placeholder="例：順番待ち登録したいです" />

    <div id="status">読み込み中...</div>
    <div id="warn" class="danger"></div>
  </div>

<script>
  const LIFF_ID = "{safe_liff_id}";

  async function main() {{
    try {{
      if (!LIFF_ID) {{
        document.getElementById("status").textContent = "";
        document.getElementById("warn").textContent =
          "LIFF_ID が未設定です。RenderのEnvironmentに LIFF_ID を入れて再デプロイしてな。";
        return;
      }}

      await liff.init({{ liffId: LIFF_ID }});

      if (!liff.isLoggedIn()) {{
        liff.login();
        return;
      }}

      const profile = await liff.getProfile();
      document.getElementById("status").textContent =
        "ログインOK\\n" +
        "表示名: " + profile.displayName + "\\n" +
        "userId: " + profile.userId;
    }} catch (e) {{
      document.getElementById("status").textContent = "";
      document.getElementById("warn").textContent =
        "LIFF 初期化でエラー: " + (e && e.message ? e.message : e);
    }}
  }}

  async function sendToChat() {{
    try {{
      const text = document.getElementById("msg").value || "順番待ちの画面から送信テスト";
      if (!liff.isLoggedIn()) {{
        liff.login();
        return;
      }}

      // chat_message.write を付けていないと sendMessages は失敗する
      await liff.sendMessages([{{
        type: "text",
        text: "【LIFF】" + text
      }}]);

      document.getElementById("status").textContent += "\\n\\n送信しました✅（チャットに戻って確認してな）";
      liff.closeWindow();
    }} catch (e) {{
      document.getElementById("warn").textContent =
        "送信できなかった: " + (e && e.message ? e.message : e) +
        "\\n※ LINE Developers のLIFF設定で scope に chat_message.write をONにしてるか確認してな。";
    }}
  }}

  main();
</script>
</body>
</html>
"""
    return HTMLResponse(content=html)
