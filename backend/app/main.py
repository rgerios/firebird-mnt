import asyncio
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

from app.api.routes import router as api_router
from app.core.database import init_db
from app.core.security import get_current_user_or_none
from app.services.scheduler import scheduler_loop

ROOT_DIR = Path(__file__).resolve().parent.parent.parent
FRONTEND_DIR = ROOT_DIR / "frontend"


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    sched_task = asyncio.create_task(scheduler_loop())
    try:
        yield
    finally:
        sched_task.cancel()


app = FastAPI(
    title="InfraMGNT - Firebird Backup, Maintenance & Validation Server",
    description="Painel centralizado e protegido para automação de Backup (gbak -b), Manutenção (gstat/gfix/isql) e Validação Física de bancos Firebird.",
    version="1.2.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(api_router)

# Mount frontend static assets (/css, /js)
if (FRONTEND_DIR / "css").is_dir():
    app.mount("/css", StaticFiles(directory=str(FRONTEND_DIR / "css")), name="css")
if (FRONTEND_DIR / "js").is_dir():
    app.mount("/js", StaticFiles(directory=str(FRONTEND_DIR / "js")), name="js")


@app.get("/login")
def serve_login(request: Request):
    if get_current_user_or_none(request):
        return RedirectResponse(url="/", status_code=302)
    return FileResponse(str(FRONTEND_DIR / "login.html"))


@app.get("/")
def serve_index(request: Request):
    if not get_current_user_or_none(request):
        return RedirectResponse(url="/login", status_code=302)
    return FileResponse(str(FRONTEND_DIR / "index.html"))
