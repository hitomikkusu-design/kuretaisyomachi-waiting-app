from fastapi.responses import HTMLResponse
import html as _html

@app.get("/liff", response_class=HTMLResponse)
def web_form():
    shop = _html.escape(SHOP_NAME)

    template = """
<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>__SHOP__ 順番受付</title>
  <style>
    body {
      font-family: system-ui, -apple-system, Segoe UI, Roboto, "Noto Sans JP", sans-serif;
      background:#f6f7f8; margin:0; padding:16px;
    }
    .card { background:#fff; border-radius:14px; padding:16px;
      box-shadow:0 6px 20px rgba(0,0,0,.06); max-width:520px; margin:0 auto; }
    h1 { font-size:18px; margin:0 0 12px; }
    label { display:block; font-size:13px; margin:12px 0 6px; }
    input { width:100%; padding:12px; border:1px solid #ddd; border-radius:10px; font-size:16px; }
    .row { display:flex; gap:8px; flex-wrap:wrap; margin-top:8px; }
    .btn { flex:1; min-width:72px; padding:12px; border-radius:10px;
      border:1px solid #ddd; background:#fff; font-size:16px; }
    .btn.active { border-color:#111; background:#eef; }
    .primary { width:100%; margin-top:14px; padding:14px; border:0; border-radius:12px;
      background:#111; color:#fff; font-size:16px; }
    .note { font-size:12px; color:#666; margin-top:10px; line-height:1.55; }
    .ok { margin-top:12px; padding:12px; border-radius:12px; background:#f0fff4; border:1px solid #bfe7c7; }
    .err { margin-top:12px; padding:12px; border-radius:12px; background:#fff3f3; border:1px solid #f0b4b4; }
  </style>
</head>
<body>
  <div class="card">
    <h1>__SHOP__ 順番受付</h1>

    <label>お名前</label>
    <input id="name" placeholder="例：山本 太郎"/>

    <label>人数</label>
    <div class="row" id="party">
      <button class="btn" onclick="setParty(event,1)">1人</button>
      <button class="btn" onclick="setParty(event,2)">2人</button>
      <button class="btn" onclick="setParty(event,3)">3人</button>
      <button class="btn" onclick="setParty(event,4)">4人</button>
      <button class="btn" onclick="setParty(event,5)">5人</button>
      <button class="btn" onclick="setParty(event,6)">6人</button>
    </div>

    <label>電話番号</label>
    <input id="phone" placeholder="09012345678"/>

    <button class="primary" onclick="submitForm()">受付する</button>

    <div id="msg"></div>

    <p class="note">
      ※ 順番が来たら LINE でお知らせします<br>
      ※ 人数は口頭で変更できます
    </p>
  </div>

<script>
let partySize = 0;

function setParty(ev, n) {
  partySize = n;
  document.querySelectorAll('.btn').forEach(b => b.classList.remove('active'));
  ev.target.classList.add('active');
}

async function submitForm() {
  const name = document.getElementById('name').value.trim();
  const phone = document.getElementById('phone').value.trim();
  const msg = document.getElementById('msg');

  if (!name || !phone || partySize === 0) {
    msg.innerHTML = '<div class="err">名前・人数・電話番号を入れてや</div>';
    return;
  }

  const res = await fetch('/register', {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({
      shop: "__SHOP__",
      name:name,
      phone:phone,
      party_size:partySize
    })
  });

  const data = await res.json();

  if (data.ok) {
    msg.innerHTML = `<div class="ok">
      受付完了やき！<br>
      <b>${data.number}番</b> やで。<br><br>
      このあと自動で LINE が開くきね。
    </div>`;

    setTimeout(() => {
      window.location.href = "https://lin.ee/0uwScY2";
    }, 1200);

  } else {
    msg.innerHTML = '<div class="err">受付できんかったき、店の人に言うて</div>';
  }
}
</script>

</body>
</html>
"""
    template = template.replace("__SHOP__", shop)
    return HTMLResponse(content=template)
