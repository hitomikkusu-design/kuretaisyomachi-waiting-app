import os
import json
import hmac
import hashlib
import base64
import httpx
from fastapi import FastAPI, Request, Header, HTTPException

app = FastAPI()

LINE_CHANNEL_SECRET = os.environ.get("LINE_CHANNEL_SECRET", "")
LINE_CHANNEL_ACCESS_TOKEN = os.environ.get("LINE_CHANNEL_ACCESS_TOKEN", "")

def verify_signature(body: bytes, signature: str) -> bool:
    if not LINE_CHANNEL_SECRET or not signature:
        return False
    mac = hmac.new(
        LINE_CHANNEL_SECRET.encode("utf-8"),
        body,
        hashlib.sha256
    ).digest()
    expected = base64.b64encode(mac).decode("utf-8")
    return hmac.compare_digest(expected, signature)

@app.get("/")
def root():
    return {"message": "Kuretaiyomachi waiting app is running!"}

@app.post("/callback")
async def callback(
    request: Request,
    x_line_signature: str = Header(None),
):
    body = await request.body()

    # 署名検証（これが通らないとLINEは危険判定する）
    if not verify_signature(body, x_line_signature):
        raise HTTPException(status_code=400, detail="Invalid signature")

    payload = json.loads(body.decode("utf-8"))

    # events がない場合もあるので安全に
    events = payload.get("events", [])
    if not events:
        return {"status": "ok"}

    # まずは「オウム返信」だけ実装（正常に返せたら次に進む）
    for event in events:
        if event.get("type") != "message":
            continue

        message = event.get("message", {})
        if message.get("type") != "text":
            continue

        reply_token = event.get("replyToken")
        user_text = message.get("text", "")

        if not reply_token:
            continue

        # LINEに返信
        await reply_to_line(reply_token, f"受け取ったで：{user_text}")

    return {"status": "ok"}


async def reply_to_line(reply_token: str, text: str):
    if not LINE_CHANNEL_ACCESS_TOKEN:
        # トークン未設定はここで止める
        raise HTTPException(status_code=500, detail="Missing access token")

    url = "https://api.line.me/v2/bot/message/reply"
    headers = {
        "Authorization": f"Bearer {LINE_CHANNEL_ACCESS_TOKEN}",
        "Content-Type": "application/json"
    }
    data = {
        "replyToken": reply_token,
        "messages": [{"type": "text", "text": text}]
    }

    async with httpx.AsyncClient(timeout=10) as client:
        r = await client.post(url, headers=headers, json=data)

    if r.status_code != 200:
        # エラー内容をRenderログに出す（デバッグ命）
        raise HTTPException(status_code=500, detail=f"LINE reply failed: {r.status_code} {r.text}")

