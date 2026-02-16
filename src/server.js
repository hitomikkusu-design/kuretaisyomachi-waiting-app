// ============================================================
//  久礼大正町市場 順番待ち（ウェイティング）アプリ
//  最小構成版 — express + Node 18 fetch のみ
// ============================================================

try { require("dotenv").config(); } catch (_) {}

const express = require("express");
const crypto = require("crypto");

const PORT = process.env.PORT || 10000;
const CHANNEL_ACCESS_TOKEN = process.env.CHANNEL_ACCESS_TOKEN || "";
const CHANNEL_SECRET = process.env.CHANNEL_SECRET || "";
const ADMIN_USER_ID = process.env.ADMIN_USER_ID || "";
const STORE_NAME = process.env.STORE_NAME || "大正町市場";

const queue = [];
const app = express();

app.get("/", (_req, res) => {
  res.status(200).send("Server OK");
});

app.post("/webhook", express.raw({ type: "*/*" }), async (req, res) => {
  res.status(200).send("OK");

  if (!verifySignature(req.body, req.headers["x-line-signature"])) {
    console.error("Invalid signature");
    return;
  }

  let body;
  try {
    body = JSON.parse(req.body.toString());
  } catch (e) {
    console.error("JSON parse error:", e.message);
    return;
  }

  const events = body.events || [];
  for (const event of events) {
    try {
      await handleEvent(event);
    } catch (err) {
      console.error("handleEvent error:", err);
    }
  }
});

function verifySignature(rawBody, signature) {
  if (!signature || !CHANNEL_SECRET) return false;
  const hash = crypto
    .createHmac("SHA256", CHANNEL_SECRET)
    .update(rawBody)
    .digest("base64");
  return hash === signature;
}

async function handleEvent(event) {
  if (event.type !== "message" || event.message.type !== "text") return;

  const userId = event.source.userId;
  const text = event.message.text.trim();
  const replyToken = event.replyToken;
  const isAdmin = userId === ADMIN_USER_ID;

  if (isAdmin) {
    if (text === "次") return await cmdNext(replyToken);
    if (text === "一覧") return await cmdList(replyToken);
    if (text === "全消し") return await cmdClearAll(replyToken);
  }

  if (text === "受付" || text === "並ぶ") return await cmdJoin(userId, replyToken);
  if (text === "取消" || text === "キャンセル") return await cmdCancel(userId, replyToken);
  if (text === "状況" || text === "何番") return await cmdStatus(userId, replyToken);
}

async function cmdJoin(userId, replyToken) {
  const idx = queue.findIndex((q) => q.userId === userId);
  if (idx !== -1) {
    const pos = idx + 1;
    return await reply(replyToken,
      `もう受付しちゅうで。いま ${pos}番目 やきね。`
    );
  }
  queue.push({ userId, joinedAt: Date.now() });
  const pos = queue.length;
  console.log(`[JOIN] userId=${userId} pos=${pos} queueSize=${queue.length}`);
  return await reply(replyToken,
    `受付できちゅうきね。いま ${pos}番目 やき、もうちょい待ちよってや。`
  );
}

async function cmdCancel(userId, replyToken) {
  const idx = queue.findIndex((q) => q.userId === userId);
  if (idx === -1) {
    return await reply(replyToken,
      "受付しちょらんみたいやけど？もっかい確認してみてや。"
    );
  }
  queue.splice(idx, 1);
  console.log(`[CANCEL] userId=${userId} queueSize=${queue.length}`);
  return await reply(replyToken,
    "取消したきね。ほいたらまた必要なったら言うてや。"
  );
}

async function cmdStatus(userId, replyToken) {
  const idx = queue.findIndex((q) => q.userId === userId);
  if (idx === -1) {
    return await reply(replyToken,
      "受付しちょらんみたいで。「受付」って送ったら並べるきね。"
    );
  }
  const pos = idx + 1;
  const ahead = idx;
  return await reply(replyToken,
    `いま ${pos}番目、前に ${ahead}人 おるき。順番きたら呼ぶで。`
  );
}

async function cmdNext(replyToken) {
  if (queue.length === 0) {
    return await reply(replyToken, "待ちよる人はおらんで。");
  }
  const next = queue.shift();
  console.log(`[NEXT] called userId=${next.userId} queueSize=${queue.length}`);

  await reply(replyToken,
    `次の人を呼んだで。残り ${queue.length}人 やき。`
  );

  await push(next.userId,
    "順番きたで！7分以内に来てや。遅れたら次の人呼ぶきね。"
  );
}

async function cmdList(replyToken) {
  if (queue.length === 0) {
    return await reply(replyToken, "いま待ちよる人はおらんで。");
  }
  const top3 = queue.slice(0, 3);
  let msg = `【${STORE_NAME}】待ち状況\n`;
  msg += `待ち人数: ${queue.length}人\n\n`;
  top3.forEach((q, i) => {
    msg += `${i + 1}番: ${q.userId.slice(-6)}…\n`;
  });
  if (queue.length > 3) {
    msg += `…ほか ${queue.length - 3}人`;
  }
  return await reply(replyToken, msg);
}

async function cmdClearAll(replyToken) {
  const count = queue.length;
  queue.length = 0;
  console.log(`[CLEAR] removed ${count} entries`);
  return await reply(replyToken,
    `全部消したで。${count}人 分クリアしたき。`
  );
}

async function reply(replyToken, text) {
  const url = "https://api.line.me/v2/bot/message/reply";
  const body = {
    replyToken,
    messages: [{ type: "text", text }],
  };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.text();
      console.error("[REPLY ERROR]", res.status, err);
    }
  } catch (e) {
    console.error("[REPLY FETCH ERROR]", e.message);
  }
}

async function push(userId, text) {
  const url = "https://api.line.me/v2/bot/message/push";
  const body = {
    to: userId,
    messages: [{ type: "text", text }],
  };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.text();
      console.error("[PUSH ERROR]", res.status, err);
    }
  } catch (e) {
    console.error("[PUSH FETCH ERROR]", e.message);
  }
}

app.listen(PORT, () => {
  console.log(`${STORE_NAME} waiting app running on port ${PORT}`);
});
