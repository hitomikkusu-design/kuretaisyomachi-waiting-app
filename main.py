from fastapi import FastAPI
from fastapi.responses import HTMLResponse

app = FastAPI()

@app.get("/liff")
def liff_page():
    return HTMLResponse("""
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>大正町 順番待ち</title>

  <!-- ★これが無いと liff is not defined になる -->
  <script src="https://static.line-scdn.net/liff/edge/2/sdk.js"></script>
</head>
<body>
  <h1>大正町 順番待ち</h1>
  <p id="status">読み込み中…</p>

  <script>
    async function main() {
      try {
        await liff.init({ liffId: "★ここにLIFF ID★" });

        if (!liff.isLoggedIn()) {
          liff.login();
          return;
        }

        const profile = await liff.getProfile();
        document.getElementById("status").innerText =
          "こんにちは " + profile.displayName + " さん";
      } catch (err) {
        document.getElementById("status").innerText =
          "LIFF初期化エラー: " + err;
      }
    }

    main();
  </script>
</body>
</html>
""")
