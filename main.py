import os
from datetime import datetime
from typing import Optional

from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, JSONResponse

from linebot import LineBotApi, WebhookHandler
from linebot.exceptions import InvalidSignatureError
from linebot.models import MessageEvent, TextMessage, TextSendMessage


# ==========
# ENV
# ==========
LINE_CHANNEL_ACCESS_TOKEN = os.getenv("LINE_CHANNEL_ACCESS_TOKEN", "")
LINE_CHANNEL_SECRET = os.getenv("LINE_CHANNEL_SECRET", "")

if not LINE_CHANNEL_ACCESS_TOKEN or not LINE_CHANNEL_SECRET:
    # Render で env が未設定のまま起動しても落ちないようにする（/statusで気づける）
    line_bot_api = None
    handler = None
else:
    line_bot_api = LineBotApi(LINE_CHANNEL_ACCESS_TOKEN)
    handler = WebhookHandler(LINE_CHANNEL_SECRET)

app = FastAPI()


# ==========
# UI (簡易ページ)
# ==========
@app.get("/", response_class=HTMLResponse)
def home():
    return """
    <html>
      <head><meta charset="utf-8"><title>大正町 順番待ち</title></head>
      <body style="font-family: sans-serif; padding: 24px;">
        <h2>大正町 順番待ち（Bot方式）</h2>
        <p>この方式は LIFF の権限問題を回避して、サーバーからLINEに通知します。</p>
        <ul>
          <li><a href="/reception">受付ページ（ダミー）</a></li>
          <li><a href="/status">ステータス確認</a></li>
        </ul>
      </body>
    </html>
    """


@app.get("/reception", response_class=HTMLResponse)
def reception():
    # ここはあとで受付フォームに拡張できる
    return """
    <html>
      <head><meta charset="utf-8"><title>受付</title></head>
      <body style="font-family: sans-serif; padding: 24px;">
        <h3>受付（仮）</h3>
        <p>いまは Bot の疎通確認が目的です。</p>
        <p>LINEのトークで「受付」など送るとBotが返します。</p>
        <p><a href="/">戻る</a></p>
      </body>
    </html>
    """


@app.get("/status")
def status():
    return {
        "ok": True,
        "time": datetime.utcnow().isoformat() + "Z",
        "env_ready": bool(LINE_CHANNEL_ACCESS_TOKEN and LINE_CHANNEL_SECRET),
        "webhook": "/webhook/line",
    }


# ==========
# LINE Webhook
# ==========
@app.post("/webhook/line")
async def webhook(request: Request):
    if handler is None:
        return JSONResponse(
            {"ok": False, "error": "LINE env is missing. Set LINE_CHANNEL_ACCESS_TOKEN and LINE_CHANNEL_SECRET."},
            status_code=500,
        )

    signature = request.headers.get("X-Line-Signature", "")
    body = await request.body()
    body_text = body.decode("utf-8")

    try:
        handler.handle(body_text, signature)
    except InvalidSignatureError:
        return JSONResponse({"ok": False, "error": "Invalid signature"}, status_code=400)

    return {"ok": True}


# ==========
# LINE message handler
# ==========
if handler is not None and line_bot_api is not None:

    @handler.add(MessageEvent, message=TextMessage)
    def handle_message(event):
        user_text = (event.message.text or "").strip()

        # ここに会話ロジックを増やしていける（順番待ち登録、呼び出し、キャンセル等）
        if user_text in ["受付", "順番待ち", "登録"]:
            reply = "受付したい内容を送ってね（例：2名、田中、など）"
        elif user_text:
            reply = f"受け取ったよ：『{user_text}』\n（※ここは後で順番待ちロジックに繋げる）"
        else:
            reply = "テキストを送ってね"

        line_bot_api.reply_message(event.reply_token, TextSendMessage(text=reply))
