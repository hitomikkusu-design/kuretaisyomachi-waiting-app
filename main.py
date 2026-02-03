from fastapi import FastAPI, Request, Header
import os
import hmac
import hashlib
import base64
import json

app = FastAPI()

# =========================
# 0) 動作確認（ブラウザで開く用）
# =========================
@app.get("/")
def root():
    return {"message": "Kuretaiyomachi waiting app is running!"}


# =========================
# 1) LINE署名検証（X-Line-Signature）
# =========================
def verify_line_signature(body: bytes, x_line_signature: str) -> bool:
    """
    LINEのWebhookは必ず署名が付いてくる。
    Channel Secret でHMAC-SHA256してbase64したものと一致すればOK。
    """
    channel_secret = os.getenv("LINE_CHANNEL_SECRET", "")
    if not channel_secret:
        # Secretが未設定なら検証できない（本番では必ず設定して）
        return False

    hash_ = hmac.new(channel_secret.encode("utf-8"), body, hashlib.sha256).digest()
    signature = base64.b64encode(hash_).decode("utf-8")
    return signature == x_line_signature


# =========================
# 2) LINE Webhook受け口（ここにPOSTが来る）
#    LINE Developers の Webhook URL にこれを入れる：
#    https://xxxxx.onrender.com/callback
# =========================
@app.post("/callback")
async def callback(
    request: Request,
    x_line_signature: str = Header(default="")
):
    body = await request.body()

    # 署名チェック
    if not verify_line_signature(body, x_line_signature):
        return {"status": "ng", "reason": "invalid signature or missing secret"}

    # JSONとして中身を見る（ログ確認用）
    try:
        payload = json.loads(body.decode("utf-8"))
    except Exception:
        payload = {"raw": body.decode("utf-8", errors="ignore")}

    print("=== LINE WEBHOOK RECEIVED ===")
    print(json.dumps(payload, ensure_ascii=False, indent=2))

    # とりあえず200を返す（重要：200以外だとLINE側でエラーになる）
    return {"status": "ok"}


# =========================
# 3) GET /callback を踏んだ時に見える表示（手で開いたとき用）
# =========================
@app.get("/callback")
def callback_get():
    return {"detail": "This endpoint is for LINE webhook POST only."}

