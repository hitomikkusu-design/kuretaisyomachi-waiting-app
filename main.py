from fastapi import FastAPI, Request
import os
import httpx

app = FastAPI()

LINE_CHANNEL_ACCESS_TOKEN = os.getenv("LINE_CHANNEL_ACCESS_TOKEN")

@app.post("/callback")
async def callback(request: Request):
    body = await request.json()
    print(body)

    events = body.get("events", [])
    for event in events:
        if event["type"] == "message":
            reply_token = event["replyToken"]
            user_message = event["message"]["text"]

            await reply_message(reply_token, f"受け取ったで：{user_message}")

    return {"status": "ok"}

async def reply_message(reply_token: str, text: str):
    url = "https://api.line.me/v2/bot/message/reply"
    headers = {
        "Authorization": f"Bearer {LINE_CHANNEL_ACCESS_TOKEN}",
        "Content-Type": "application/json"
    }
    payload = {
        "replyToken": reply_token,
        "messages": [
            {"type": "text", "text": text}
        ]
    }

    async with httpx.AsyncClient() as client:
        await client.post(url, headers=headers, json=payload)

@app.get("/")
def read_root():
    return {"message": "Kuretaiyomachi waiting app is running"}
