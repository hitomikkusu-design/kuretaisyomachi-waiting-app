import os
import json
import hmac
import hashlib
import base64
import httpx
from typing import List, Dict, Any, Optional

from fastapi import FastAPI, Request, Header
from fastapi.responses import PlainTextResponse, JSONResponse

app = FastAPI()

# =========
# 環境変数
# =========
CHANNEL_ACCESS_TOKEN = os.getenv("LINE_CHANNEL_ACCESS_TOKEN", "")
CHANNEL_SECRET = os.getenv("LINE_CHANNEL_SECRET", "")
ADMIN_USER_IDS = [u.strip() for u in os.getenv("ADMIN_USER_IDS", "").split(",") if u.strip()]

LINE_REPLY_ENDPOINT = "https://api.line.me/v2/bot/message/reply"
LINE_PUSH_ENDPOINT  = "https://api.line.me/v2/bot/message/push"

# =========
# メモリ上の待ちリスト（まずは簡易版）
# 本番はスプレッドシート等に保存へ
# =========
# item: {"name": str, "party": int, "userId": str}
QUEUE: List[Dict[str, Any]] = []


# =========
# ユーティリティ
# =========
def is_admin(user_id: str) -> bool:
    return user_id in ADMIN_USER_IDS

def verify_signature(body: bytes, x_line_signature: Optional[str]) -> bool:
    if not CHANNEL_SECRET:
        return False
    if not x_line_signature:
        return False
    digest = hmac.new(CHANNEL_SECRET.encode("utf-8"), body, hashlib.sha256).digest()
    signature = base64.b64encode(digest).decode("utf-8")
    return hmac.compare_digest(signature, x_line_signature)

async def line_reply(reply_token: str, text: str):
    if not CHANNEL_ACCESS_TOKEN:
        return
    headers = {
        "Authorization": f"Bearer {CHANNEL_ACCESS_TOKEN}",
        "Content-Type": "application/json",
    }
    payload = {
        "replyToken": reply_token,
        "messages": [{"type": "text", "text": text}],
    }
    async with httpx.AsyncClient(timeout=10) as client:
        await client.post(LINE_REPLY_ENDPOINT, headers=headers, json=payload)

async def line_push(to_user_id: str, text: str):
    if not CHANNEL_ACCESS_TOKEN:
        return
    headers = {
        "Authorization": f"Bearer {CHANNEL_ACCESS_TOKEN}",
        "Content-Type": "application/json",
    }
    payload = {
        "to": to_user_id,
        "messages": [{"type": "text", "text": text}],
    }
    async with httpx.AsyncClient(timeout=10) as client:
        await client.post(LINE_PUSH_ENDPOINT, headers=headers, json=payload)

def format_queue() -> str:
    if not QUEUE:
        return "📭 いま待ちゼロやで。"
    lines = ["🧾 現在の待ちリスト"]
    for i, item in enumerate(QUEUE, start=1):
        lines.append(f"{i}. {item['name']}（{item['party']}名）")
    return "\n".join(lines)

def help_text() -> str:
    return (
        "✅ 管理コマンド（管理者だけ有効）\n"
        "・一覧\n"
        "・追加 名前 人数   例）追加 山田 2\n"
        "・次   （先頭を呼び出す）\n"
        "・完了 （先頭を削除）\n"
        "・クリア（全消し）\n"
        "・ヘルプ\n"
    )


# =========
# ルート確認
# =========
@app.get("/")
def root():
    return {"message": "Kuretaisyomachi waiting app is running!"}


# =========
# LINE Webhook
# =========
@app.post("/callback")
async def callback(request: Request, x_line_signature: str = Header(default=None)):
    body = await request.body()

    # 署名検証（安全）
    if not verify_signature(body, x_line_signature):
        # LINEの検証が通らん時の原因になるので、ここはちゃんと弾く
        return PlainTextResponse("Invalid signature", status_code=400)

    data = json.loads(body.decode("utf-8"))

    # eventsが無い時は何もしない
    events = data.get("events", [])
    if not events:
        return JSONResponse({"status": "ok"})

    for event in events:
        event_type = event.get("type")
        if event_type != "message":
            continue

        message = event.get("message", {})
        if message.get("type") != "text":
            continue

        text = (message.get("text") or "").strip()
        reply_token = event.get("replyToken")
        user_id = (event.get("source") or {}).get("userId", "")

        # ---- 管理者じゃない場合：ここで終了（必要なら案内文だけ返す）
        if not is_admin(user_id):
            # お客さん用に何か返したいならここ編集（今は無反応にしておくのが安全）
            await line_reply(reply_token, "受付はスタッフが操作します🙏")
            continue

        # ---- 管理者コマンド処理
        # コマンド：ヘルプ
        if text in ["ヘルプ", "help", "？", "?"]:
            await line_reply(reply_token, help_text())
            continue

        # コマンド：一覧
        if text in ["一覧", "list"]:
            await line_reply(reply_token, format_queue())
            continue

        # コマンド：クリア
        if text in ["クリア", "clear"]:
            QUEUE.clear()
            await line_reply(reply_token, "🧹 待ちリストを全消ししたで。")
            continue

        # コマンド：追加 名前 人数
        # 例）追加 山田 2
        if text.startswith("追加"):
            parts = text.split()
            if len(parts) < 3:
                await line_reply(reply_token, "❗使い方：追加 名前 人数（例：追加 山田 2）")
                continue
            name = parts[1]
            try:
                party = int(parts[2])
            except:
                await line_reply(reply_token, "❗人数は数字で入れてな（例：追加 山田 2）")
                continue
            if party <= 0:
                await line_reply(reply_token, "❗人数は1以上でお願い🙏")
                continue

            QUEUE.append({"name": name, "party": party, "userId": user_id})
            await line_reply(reply_token, f"✅ 追加したで：{name}（{party}名）\n\n" + format_queue())
            continue

        # コマンド：次（先頭を呼ぶ）
        if text in ["次", "つぎ", "next"]:
            if not QUEUE:
                await line_reply(reply_token, "📭 いま待ちゼロやで。")
                continue
            item = QUEUE[0]
            name = item["name"]
            party = item["party"]

            # ※本来は「お客さんのuserId」にpushする。いまは簡易で“管理者に確認”だけ返す。
            # お客さんのuserIdを紐づける設計（QRで友だち追加→受付登録）にしたらpush先を変える。
            await line_reply(reply_token, f"📣 次の呼び出し：{name}（{party}名）\n（※お客さんへの自動通知は次のフェーズで実装）")
            continue

        # コマンド：完了（先頭を削除）
        if text in ["完了", "削除", "done"]:
            if not QUEUE:
                await line_reply(reply_token, "📭 いま待ちゼロやで。")
                continue
            item = QUEUE.pop(0)
            await line_reply(reply_token, f"✅ 完了：{item['name']}（{item['party']}名）\n\n" + format_queue())
            continue

        # 何でもない時
        await line_reply(reply_token, "✅ 管理コマンドは「ヘルプ」見てな。")

    return JSONResponse({"status": "ok"})
from fastapi.responses import HTMLResponse

@app.get("/liff", response_class=HTMLResponse)
def liff_page():
    return """
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <title>大正町 順番待ち</title>
      <script src="https://static.line-scdn.net/liff/edge/2/sdk.js"></script>
    </head>
    <body>
      <h1>大正町 順番待ち</h1>
      <p id="user">読み込み中...</p>

      <script>
        const liffId = "あとでここを差し替え";

        liff.init({ liffId }).then(() => {
          if (!liff.isLoggedIn()) {
            liff.login();
          } else {
            liff.getProfile().then(profile => {
              document.getElementById("user").innerText =
                profile.displayName + " さん、ようこそ";
            });
          }
        });
      </script>
    </body>
    </html>
    """
