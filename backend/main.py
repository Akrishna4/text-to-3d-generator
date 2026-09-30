"""
main.py — FastAPI backend for OneImmersive Text-to-3D
======================================================

Architecture:
  POST /api/generate          → starts a background job, returns {job_id}
  GET  /api/jobs/{job_id}     → poll for status / model URL
  GET  /api/models/{job_id}   → serve the GLB file with download header
  GET  /api/samples           → list pre-baked sample models
  GET  /health                → liveness probe (used by HF Spaces)

Job lifecycle: queued → running → done | failed
State is kept in a Python dict (fine for single-process deployment).
Files are saved to ./models/ on disk.

Key design decisions:
  1. Async job pattern: POST returns immediately so Render/HF timeouts
     don't kill long-running generation (can take 60-120 s).
  2. asyncio.create_task() runs generation concurrently on the same
     process's event loop; the thread pool in the provider handles
     the blocking gradio_client calls.
  3. Per-IP rate limiting via slowapi: 5 generate requests per minute.
  4. CORS is wide-open in dev; tighten ALLOWED_ORIGINS in production.
"""
from __future__ import annotations

import asyncio
import logging
import os
import pathlib
import re
import time
import uuid
from contextlib import asynccontextmanager

from fastapi import BackgroundTasks, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, field_validator
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address

# ── Configuration ─────────────────────────────────────────────────────────────

# Load .env first so all os.environ calls below see the values
from dotenv import load_dotenv
load_dotenv(pathlib.Path(__file__).parent / ".env")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-8s %(name)s  %(message)s",
)
logger = logging.getLogger("main")

BASE_DIR    = pathlib.Path(__file__).parent
MODELS_DIR  = pathlib.Path(os.environ.get("MODELS_DIR", "/tmp/models"))
SAMPLES_DIR = BASE_DIR / "samples"          # pre-baked GLBs shipped with the repo
MODELS_DIR.mkdir(parents=True, exist_ok=True)
SAMPLES_DIR.mkdir(exist_ok=True)

MAX_PROMPT_LEN      = 300
RATE_LIMIT          = "5/minute"                 # per IP
GENERATION_TIMEOUT  = 300                        # seconds — 5 minutes hard cap

# User-facing messages (never expose raw upstream errors)
_MSG_QUOTA = (
    "Live generation is temporarily unavailable because the free GPU quota is "
    "used up. Please try the sample models, or try again later."
)
_MSG_TIMEOUT = (
    "Generation timed out after 5 minutes. The AI service may be busy — "
    "please try again later, or try a sample model."
)

# ── In-memory job store ───────────────────────────────────────────────────────
# Each job: {status, prompt, created_at, updated_at, model_url?, error?}
# Fine for a single-process server; swap for Redis if you scale horizontally.

class JobStatus:
    QUEUED  = "queued"
    RUNNING = "running"
    DONE    = "done"
    FAILED  = "failed"

jobs: dict[str, dict] = {}

# ── Rate limiter ──────────────────────────────────────────────────────────────

limiter = Limiter(key_func=get_remote_address)

# ── Provider (lazy init in lifespan) ─────────────────────────────────────────

provider = None   # set during startup

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Initialise the provider once at startup."""
    global provider
    from providers import get_provider
    try:
        provider = get_provider(MODELS_DIR)
        logger.info("Provider ready: %s", type(provider).__name__)
    except Exception as exc:
        logger.error("Failed to init provider: %s", exc)
        # Don't crash startup — the /generate endpoint will return a clear error
    yield
    # (cleanup if needed)

# ── App ───────────────────────────────────────────────────────────────────────

app = FastAPI(
    title="OneImmersive Text-to-3D",
    version="1.0.0",
    lifespan=lifespan,
)

app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],   # tighten in production if needed
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Request / response models ─────────────────────────────────────────────────

class GenerateRequest(BaseModel):
    prompt: str

    @field_validator("prompt")
    @classmethod
    def validate_prompt(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("Prompt must not be empty.")
        if len(v) > MAX_PROMPT_LEN:
            raise ValueError(f"Prompt must be ≤ {MAX_PROMPT_LEN} characters.")
        # Basic sanity: reject prompts that are only punctuation/numbers
        if not re.search(r"[a-zA-Z]", v):
            raise ValueError("Prompt must contain at least one word.")
        return v

# ── Background task ───────────────────────────────────────────────────────────

async def run_generation(job_id: str, prompt: str) -> None:
    """
    Background coroutine: runs the provider, updates job state.
    Errors are caught here so they don't surface as unhandled exceptions.

    Error handling policy:
      - ZeroGPU/quota errors  → friendly quota message (raw error logged only)
      - asyncio.TimeoutError  → friendly timeout message
      - All other errors      → str(exc) as before (already friendly from provider)
    """
    jobs[job_id]["status"]     = JobStatus.RUNNING
    jobs[job_id]["updated_at"] = time.time()
    logger.info("Job %s started: %r", job_id, prompt)

    try:
        glb_path = await asyncio.wait_for(
            provider.generate(prompt, job_id),
            timeout=GENERATION_TIMEOUT,
        )
        jobs[job_id]["status"]    = JobStatus.DONE
        jobs[job_id]["model_url"] = f"/api/models/{job_id}.glb"
        logger.info("Job %s done → %s", job_id, glb_path)
    except asyncio.TimeoutError:
        jobs[job_id]["status"] = JobStatus.FAILED
        jobs[job_id]["error"]  = _MSG_TIMEOUT
        logger.error("Job %s timed out after %ds", job_id, GENERATION_TIMEOUT)
    except Exception as exc:
        raw = str(exc)
        # Detect ZeroGPU/quota errors and replace with a user-friendly message
        if "quota" in raw.lower() or "zerogpu" in raw.lower():
            user_msg = _MSG_QUOTA
            logger.error("Job %s quota error (hidden from user): %s", job_id, raw)
        else:
            user_msg = raw
            logger.error("Job %s failed: %s", job_id, raw)
        jobs[job_id]["status"] = JobStatus.FAILED
        jobs[job_id]["error"]  = user_msg
    finally:
        jobs[job_id]["updated_at"] = time.time()

# ── Endpoints ─────────────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    """
    Liveness probe. HF Spaces and load balancers call this to confirm
    the container is alive. Also shows whether the provider initialised.
    """
    return {
        "status": "ok",
        "provider": type(provider).__name__ if provider else "not initialised",
        "active_jobs": sum(1 for j in jobs.values() if j["status"] in (JobStatus.QUEUED, JobStatus.RUNNING)),
    }


@app.post("/api/generate")
@limiter.limit(RATE_LIMIT)
async def generate(
    request: Request,              # required by slowapi
    body: GenerateRequest,
    background_tasks: BackgroundTasks,
):
    """
    Start a generation job. Returns a job_id immediately.
    The client should poll GET /api/jobs/{job_id} for status.

    Rate limited to 5 requests/minute per IP to protect the free HF quota.
    """
    if provider is None:
        raise HTTPException(
            status_code=503,
            detail="AI provider is not available. Check server logs.",
        )

    job_id = uuid.uuid4().hex
    jobs[job_id] = {
        "job_id":     job_id,
        "status":     JobStatus.QUEUED,
        "prompt":     body.prompt,
        "created_at": time.time(),
        "updated_at": time.time(),
        "model_url":  None,
        "error":      None,
    }

    # Fire-and-forget: does not block the HTTP response
    background_tasks.add_task(run_generation, job_id, body.prompt)

    logger.info("Job %s queued: %r", job_id, body.prompt)
    return {"job_id": job_id, "status": JobStatus.QUEUED}


@app.get("/api/jobs/{job_id}")
async def get_job(job_id: str):
    """
    Poll for job status.

    Returns:
      status:    "queued" | "running" | "done" | "failed"
      model_url: set when status == "done"; relative URL to fetch the GLB
      error:     set when status == "failed"; human-readable message
      elapsed_s: seconds since the job was created
    """
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found.")

    return {
        **job,
        "elapsed_s": round(time.time() - job["created_at"], 1),
    }


@app.get("/api/models/{filename}")
async def serve_model(filename: str):
    """
    Serve a generated GLB file.

    The filename must be <job_id>.glb.
    We set Content-Disposition so the browser downloads it with a
    prompt-derived name (e.g. "a_small_ceramic_teapot.glb").
    """
    # Validate filename: only hex job IDs + .glb
    if not re.fullmatch(r"[0-9a-f]{32}\.glb", filename):
        raise HTTPException(status_code=400, detail="Invalid filename.")

    job_id = filename[:-4]  # strip .glb
    path   = MODELS_DIR / filename

    if not path.exists():
        raise HTTPException(status_code=404, detail="Model file not found.")

    # Build a download-friendly name from the original prompt
    job = jobs.get(job_id, {})
    prompt = job.get("prompt", "model")
    safe_name = re.sub(r"[^a-z0-9]+", "_", prompt.lower()).strip("_")[:50]
    download_name = f"{safe_name}.glb"

    return FileResponse(
        path=path,
        media_type="model/gltf-binary",
        headers={"Content-Disposition": f'attachment; filename="{download_name}"'},
    )


@app.get("/api/samples")
async def list_samples():
    """
    Return metadata for pre-baked sample models.
    These are shipped with the repo so the app demos even if the AI provider
    is down or the HF Space is sleeping.
    """
    samples = []
    for glb in sorted(SAMPLES_DIR.glob("*.glb")):
        # Filenames: <slug>.glb  e.g. ceramic_teapot.glb
        label = glb.stem.replace("_", " ").title()
        samples.append({
            "label":     label,
            "model_url": f"/api/samples/{glb.name}",
        })
    return {"samples": samples}


@app.get("/api/samples/{filename}")
async def serve_sample(filename: str):
    """Serve a pre-baked sample GLB."""
    # Only allow safe filenames
    if not re.fullmatch(r"[a-z0-9_\-]+\.glb", filename):
        raise HTTPException(status_code=400, detail="Invalid filename.")

    path = SAMPLES_DIR / filename
    if not path.exists():
        raise HTTPException(status_code=404, detail="Sample not found.")

    return FileResponse(
        path=path,
        media_type="model/gltf-binary",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# ── Serve Vite frontend (production) ─────────────────────────────────────────
# In development, Vite runs on its own port (5173) and proxies /api to here.
# In production (Docker), the built frontend lives at ../frontend/dist.

_frontend_dist = BASE_DIR.parent / "frontend" / "dist"
if _frontend_dist.exists():
    # Catch-all: serve index.html for any non-API route (SPA routing)
    from fastapi.responses import HTMLResponse

    app.mount("/assets", StaticFiles(directory=_frontend_dist / "assets"), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    async def spa_fallback(full_path: str):
        index = _frontend_dist / "index.html"
        return HTMLResponse(index.read_text())
else:
    logger.info(
        "Frontend dist not found at %s — running in API-only mode (dev)", _frontend_dist
    )
