import os
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from linebot import LineBotApi, WebhookHandler
from linebot.exceptions import InvalidSignatureError
from linebot.models import MessageEvent, TextMessage, TextSendMessage

app = FastAPI()

LINE_CHANNEL_ACCESS_TOKEN = os.getenv("LINE_CHANNEL_ACCESS_TOKEN", "")
LINE_CHANNEL_SECRET = os.getenv("LINE_CHANNEL_SECRET", "")

line_bot_api = LineBotApi(LINE_CHANNEL_ACCESS_TOKEN)
handler = WebhookHandler(LINE_CHANNEL_SECRET)

WELCOME_TEXT = (
    "ようこそ😊「大正町 順番待ち」です。\n"
    "まずは下のどれかを送ってね👇\n\n"
    "✅ 受付（順番待ちに登録）\n"
    "✅ 状況（今の順番を確認）\n"
    "✅ キャンセル（受付を取り消す）\n"
    "✅ ヘルプ（使い方）"
)

HELP_TEXT = (
    "使い方👇\n\n"
    "①「受付」→ 順番待ち登録\n"
    "②「状況」→ あと何人か確認\n"
    "③「キャンセル」→ 受付取り消し\n\n"
    "迷ったら「受付」って送ってみて😊"
)

UNKNOWN_TEXT = (
    "ごめんね🙏 ちょっとだけ分からなかった💦\n\n"
    "できることはこれ👇\n"
    "✅ 受付\n"
    "✅ 状況\n"
    "✅ キャンセル\n"
    "✅ ヘルプ\n\n"
    "まずは「受付」って送ってみてね😊"
)

# いまは「アプリ感」を先に作るため、受付番号は仮で返す（後でスプレッドシート連携で本番化）
def fake_register(user_id: str):
    # 本番ではここでDB/スプレッドシートに保存して受付番号を発行
    number = user_id[-4:]  # 仮：末尾4桁を番号っぽく見せる
    return number

def fake_status(user_id: str):
    # 本番ではここで「あなたの番号」「残り人数」を計算
    number = user_id[-4:]
    remaining = 3
    eta_min = 15
    return number, remaining, eta_min

def fake_cancel(user_id: str):
    # 本番ではここで受付データ削除
    return True

@app.get("/status")
def status():
    return {"ok": True}

@app.post("/webhook/line")
async def webhook(request: Request):
    signature = request.headers.get("X-Line-Signature", "")
    body = await request.body()
    body_text = body.decode("utf-8")

    try:
        handler.handle(body_text, signature)
    except InvalidSignatureError:
        return JSONResponse(status_code=400, content={"detail": "Invalid signature"})
    return {"ok": True}

@handler.add(MessageEvent, message=TextMessage)
def handle_message(event: MessageEvent):
    text = (event.message.text or "").strip()
    user_id = event.source.user_id

    # ひらがな/カタカナ/揺れを吸収
    t = text.lower()

    if t in ["ヘルプ", "help", "使い方", "つかいかた"]:
        line_bot_api.reply_message(
            event.reply_token,
            TextSendMessage(text=HELP_TEXT)
        )
        return

    if t in ["受付", "順番待ち", "登録", "うけつけ"]:
        num = fake_register(user_id)
        msg = (
            "受付できたよ✅\n"
            f"受付番号：{num}\n"
            "呼び出しが近づいたらLINEでお知らせするね📣\n\n"
            "途中で取り消すなら「キャンセル」って送ってね。"
        )
        line_bot_api.reply_message(
            event.reply_token,
            TextSendMessage(text=msg)
        )
        return

    if t in ["状況", "確認", "あと何人", "あとなんにん", "じょうきょう"]:
        num, remaining, eta = fake_status(user_id)
        msg = (
            "いまの状況はこちら👇\n"
            f"あなたの番号：{num}\n"
            f"あと {remaining} 人で呼び出し予定\n\n"
            f"目安：だいたい {eta} 分くらい😊\n"
            "※混雑状況で前後するよ"
        )
        line_bot_api.reply_message(
            event.reply_token,
            TextSendMessage(text=msg)
        )
        return

    if t in ["キャンセル", "取消", "取り消し", "とりけし", "cancel"]:
        ok = fake_cancel(user_id)
        msg = "キャンセルOK✅\nまた必要になったら「受付」って送ってね😊" if ok else "キャンセルできなかった🙏 もう一回試してね。"
        line_bot_api.reply_message(
            event.reply_token,
            TextSendMessage(text=msg)
        )
        return

    # それ以外（迷子救済）
    line_bot_api.reply_message(
        event.reply_token,
        TextSendMessage(text=UNKNOWN_TEXT)
    )
