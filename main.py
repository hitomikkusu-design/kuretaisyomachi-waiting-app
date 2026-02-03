import os
import json
import hmac
import hashlib
import base64
from datetime import datetime, date
from typing import Dict, List, Optional

import httpx
from fastapi import FastAPI, Request, Header, HTTPException

app = FastAPI()

LINE_CHANNEL_SECRET = os.getenv("LINE_CHANNEL_SECRET", "")
LINE_CHANNEL_ACCESS_TOKEN = os.getenv("LINE_CHANNEL_ACCESS_TOKEN", "")
ADMIN_USER_IDS = set(
    [x.strip() for x in os.getenv("ADMIN_USER_IDS", "").split(",") if x.strip()]
)

# ---- 超シンプルな永続化（Render再起動で消える可能性あり）
# 本格運用はDB/スプレッドシートに移行推奨。今は「動く完成版」優先。
STATE_FILE = "/tmp/waiting_state.json"


def _today_key() -> str:
    return date.today().isoformat()


def load_state() -> dict:
    try:
        with open(STATE_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {
            "date": _today_key(),
            "current": 0,          # 呼び出し済みの番号（ここから次へ進む）
            "next_no": 1,          # 次に発行する受付番号
            "queue": [],           # [{no, userId, name, createdAt}]
        }


def save_state(state: dict) -> None:
    with open(STATE_FILE, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=2)


def ensure_today(state: dict) -> dict:
    if state.get("date") != _today_key():
        # 日付が変わったら自動リセット（朝イチで前日の残りを消さないよう注意したい場合はOFFにしてね）
        state = {
            "date": _today_key(),
            "current": 0,
            "next_no": 1,
            "queue": [],
        }
    return state


def verify_signature(body: bytes, x_line_signature: str) -> bool:
    if not LINE_CHANNEL_SECRET:
        return False
    mac = hmac.new(LINE_CHANNEL_SECRET.encode("utf-8"), body, hashlib.sha256).digest()
    expected = base64.b64encode(mac).decode("utf-8")
    return hmac.compare_digest(expected, x_line_signature)


async def reply_message(reply_token: str, text: str) -> None:
    if not LINE_CHANNEL_ACCESS_TOKEN:
        return

    url = "https://api.line.me/v2/bot/message/reply"
    headers = {
        "Authorization": f"Bearer {LINE_CHANNEL_ACCESS_TOKEN}",
        "Content-Type": "application/json",
    }
    payload = {
        "replyToken": reply_token,
        "messages": [{"type": "text", "text": text}],
    }

    async with httpx.AsyncClient(timeout=10) as client:
        r = await client.post(url, headers=headers, json=payload)
        # 失敗しても落とさない（ログで追えるように）
        if r.status_code >= 300:
            print("LINE reply failed:", r.status_code, r.text)


def find_entry_by_user(state: dict, user_id: str) -> Optional[dict]:
    for item in state["queue"]:
        if item["userId"] == user_id:
            return item
    return None


def position_ahead(state: dict, user_id: str) -> Optional[int]:
    # 自分より前に何人いるか
    for idx, item in enumerate(state["queue"]):
        if item["userId"] == user_id:
            return idx
    return None


def cleanup_called(state: dict) -> dict:
    # current より小さい番号はキューから削る（呼び出し済み整理）
    cur = state.get("current", 0)
    state["queue"] = [x for x in state["queue"] if x["no"] > cur]
    return state


@app.get("/")
def root():
    return {"message": "Kuretaisyomachi waiting app is running!"}


@app.post("/callback")
async def callback(
    request: Request,
    x_line_signature: str = Header(default=""),
):
    body = await request.body()

    # 署名チェック
    if not verify_signature(body, x_line_signature):
        raise HTTPException(status_code=400, detail="Bad signature")

    data = json.loads(body.decode("utf-8"))
    events = data.get("events", [])

    state = ensure_today(load_state())
    state = cleanup_called(state)

    for ev in events:
        ev_type = ev.get("type")
        reply_token = ev.get("replyToken", "")
        source = ev.get("source", {})
        user_id = source.get("userId", "")

        # follow（友だち追加）
        if ev_type == "follow" and reply_token:
            msg = (
                "友だち追加ありがとう！\n"
                "【順番待ち】\n"
                "・受付 →「受付」\n"
                "・状況確認 →「状況」\n"
                "・キャンセル →「キャンセル」\n"
                "\n"
                "（店側）\n"
                "・次の呼び出し →「次」\n"
                "・一覧 →「一覧」\n"
                "・リセット →「リセット」"
            )
            await reply_message(reply_token, msg)
            continue

        # メッセージ以外は無視（必要なら追加）
        if ev_type != "message":
            continue

        message = ev.get("message", {})
        if message.get("type") != "text":
            if reply_token:
                await reply_message(reply_token, "文字で「受付」「状況」「キャンセル」って送ってね。")
            continue

        text = (message.get("text") or "").strip()

        # ---- 管理コマンド（ADMIN_USER_IDS に入ってる人だけ）
        is_admin = (user_id in ADMIN_USER_IDS) if ADMIN_USER_IDS else False

        if is_admin and text in ["次", "つぎ", "NEXT", "next"]:
            # 次の番号へ進める
            if len(state["queue"]) == 0:
                await reply_message(reply_token, "いま待ちリストは空です。")
            else:
                # 先頭を呼び出し
                called = state["queue"][0]
                state["current"] = called["no"]
                state = cleanup_called(state)
                save_state(state)
                await reply_message(reply_token, f"呼び出し：{called['no']}番（次のお客さんへ）")
            continue

        if is_admin and text in ["一覧", "リスト", "list"]:
            if len(state["queue"]) == 0:
                await reply_message(reply_token, "いま待ちリストは空です。")
            else:
                lines = [f"{x['no']}番" for x in state["queue"][:20]]
                more = "" if len(state["queue"]) <= 20 else f"\n…他 {len(state['queue'])-20} 件"
                await reply_message(reply_token, "いまの待ち：\n" + "\n".join(lines) + more)
            continue

        if is_admin and text in ["リセット", "reset", "RESET"]:
            state = {
                "date": _today_key(),
                "current": 0,
                "next_no": 1,
                "queue": [],
            }
            save_state(state)
            await reply_message(reply_token, "待ちリストをリセットしました。")
            continue

        # ---- お客さんコマンド
        if text in ["受付", "うけつけ", "並ぶ", "ならぶ"]:
            existing = find_entry_by_user(state, user_id)
            if existing:
                ahead = position_ahead(state, user_id)
                msg = f"すでに受付済みです。\nあなたは {existing['no']}番。\n前に {ahead} 人います。"
                await reply_message(reply_token, msg)
            else:
                no = state["next_no"]
                state["next_no"] += 1
                entry = {
                    "no": no,
                    "userId": user_id,
                    "name": "unknown",
                    "createdAt": datetime.now().isoformat(timespec="seconds"),
                }
                state["queue"].append(entry)
                save_state(state)

                ahead = position_ahead(state, user_id)
                msg = f"受付完了！\nあなたは {no}番です。\n前に {ahead} 人います。\n\n状況は「状況」で確認できます。"
                await reply_message(reply_token, msg)
            continue

        if text in ["状況", "じょうきょう", "確認", "かくにん"]:
            existing = find_entry_by_user(state, user_id)
            if not existing:
                await reply_message(reply_token, "まだ受付していません。\n「受付」と送ってね。")
            else:
                ahead = position_ahead(state, user_id)
                cur = state.get("current", 0)
                msg = (
                    f"あなたは {existing['no']}番です。\n"
                    f"前に {ahead} 人います。\n"
                    f"いま呼び出し済み：{cur}番まで"
                )
                await reply_message(reply_token, msg)
            continue

        if text in ["キャンセル", "取り消し", "取消", "やめる"]:
            existing = find_entry_by_user(state, user_id)
            if not existing:
                await reply_message(reply_token, "キャンセル対象がありません。\n（まだ受付していないみたい）")
            else:
                state["queue"] = [x for x in state["queue"] if x["userId"] != user_id]
                save_state(state)
                await reply_message(reply_token, f"{existing['no']}番の受付をキャンセルしました。")
            continue

        # その他の文
        help_msg = (
            "使い方はこちら👇\n"
            "・受付 →「受付」\n"
            "・状況 →「状況」\n"
            "・キャンセル →「キャンセル」"
        )
        await reply_message(reply_token, help_msg)

    return {"status": "ok"}
