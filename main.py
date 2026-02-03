from fastapi import FastAPI

app = FastAPI()
from fastapi import Request

@app.post("/callback")
async def callback(request: Request):
    body = await request.body()
    print(body)
    return {"status": "ok"}

@app.get("/")
def read_root():
    return {"message": "Kuretaiyomachi waiting app is running!"}
