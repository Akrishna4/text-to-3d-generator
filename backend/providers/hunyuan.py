"""
providers/hunyuan.py
--------------------
Two-step provider:
  1. FLUX.1-schnell HF Space  →  generates a reference image from the prompt
  2. Hunyuan3D-2 HF Space     →  generates a GLB mesh from the image

Both steps use gradio_client with handle_file() for local file uploads.
Credentials are read from HF_TOKEN env var.

Why this pipeline?
  - FLUX.1-schnell is ~10 s, free, high quality
  - Hunyuan3D-2 /shape_generation accepts any image, returns GLB
  - No local GPU required; everything runs on HF Spaces

Limitations:
  - HF Spaces queue at peak hours → job may wait in queue (included in elapsed)
  - White-mesh output (no texture) at default settings; good enough for demo
  - Space may sleep after inactivity → first request wakes it (cold start ~30 s)
"""
from __future__ import annotations

import asyncio
import logging
import pathlib
import shutil
import time
import functools

from gradio_client import Client, handle_file

from providers.base import Provider, ProviderError

logger = logging.getLogger(__name__)

# HF Space IDs — public, no special access needed
_FLUX_SPACE   = "black-forest-labs/FLUX.1-schnell"
_HUNYUAN_SPACE = "tencent/Hunyuan3D-2"


class HunyuanProvider(Provider):
    """
    FLUX.1-schnell → Hunyuan3D-2 pipeline.

    Both clients are created lazily on first use, then reused.
    Client creation is not thread-safe so we guard with an asyncio.Lock
    and run the blocking gradio_client calls in a thread pool.
    """

    def __init__(self, hf_token: str, output_dir: pathlib.Path):
        self._token     = hf_token
        self._output_dir = output_dir
        self._flux_client: Client | None    = None
        self._hunyuan_client: Client | None = None
        self._lock = asyncio.Lock()  # guards lazy client init

    # ── client management ────────────────────────────────────────────────────

    def _get_flux_client(self) -> Client:
        if self._flux_client is None:
            logger.info("Connecting to FLUX.1-schnell Space…")
            self._flux_client = Client(_FLUX_SPACE, token=self._token)
        return self._flux_client

    def _get_hunyuan_client(self) -> Client:
        if self._hunyuan_client is None:
            logger.info("Connecting to Hunyuan3D-2 Space…")
            self._hunyuan_client = Client(_HUNYUAN_SPACE, token=self._token)
        return self._hunyuan_client

    # ── core generation ──────────────────────────────────────────────────────

    def _generate_image_sync(self, prompt: str) -> str:
        """Blocking: call FLUX and return local image path."""
        client = self._get_flux_client()
        logger.info("FLUX: generating image for prompt=%r", prompt)
        t0 = time.perf_counter()

        # We add cues to help Hunyuan3D reconstruct a clean mesh
        enhanced = (
            f"{prompt}, white background, studio lighting, "
            "isolated object, product photo, sharp focus"
        )
        result = client.predict(
            prompt=enhanced,
            seed=42,
            randomize_seed=False,
            width=1024,
            height=1024,
            num_inference_steps=4,   # schnell is designed for exactly 4 steps
            api_name="/infer",
        )
        # Returns (image_dict, seed); image_dict["path"] is a local tmp file
        img_data = result[0]
        img_path = img_data["path"] if isinstance(img_data, dict) else img_data
        elapsed = time.perf_counter() - t0
        logger.info("FLUX: done in %.1fs → %s", elapsed, img_path)
        return img_path

    def _generate_3d_sync(self, img_path: str, job_id: str) -> str:
        """Blocking: call Hunyuan3D-2 and save GLB to output_dir."""
        client = self._get_hunyuan_client()
        logger.info("Hunyuan3D-2: generating GLB from image=%s", img_path)
        t0 = time.perf_counter()

        result = client.predict(
            caption=None,               # text-to-3D disabled on public Space
            image=handle_file(img_path),# image-to-3D is enabled
            mv_image_front=None,
            mv_image_back=None,
            mv_image_left=None,
            mv_image_right=None,
            steps=20,                   # 20 = good quality/speed trade-off
            guidance_scale=5.0,
            seed=42,
            octree_resolution=256,      # 256 = ~6 MB mesh, fast enough for demo
            check_box_rembg=True,       # auto-remove background (key for quality)
            num_chunks=8000,
            randomize_seed=False,
            api_name="/shape_generation",
        )
        elapsed = time.perf_counter() - t0
        logger.info("Hunyuan3D-2: done in %.1fs", elapsed)

        # Result is a tuple: (file_info, html, stats_dict, seed)
        # The first element is the mesh file.
        raw = result[0] if isinstance(result, (list, tuple)) else result

        # gradio_client may return a dict {"value": path, "__type__": "update"}
        # or a plain path string — handle both.
        if isinstance(raw, dict):
            file_path = raw.get("value") or raw.get("path") or raw.get("name")
        else:
            file_path = raw

        if not file_path or not pathlib.Path(file_path).exists():
            raise ProviderError(
                f"Hunyuan3D-2 returned no usable file path. Raw result: {str(raw)[:200]}"
            )

        # Copy to our managed output directory with a stable name
        src = pathlib.Path(file_path)
        suffix = src.suffix or ".glb"
        dest = self._output_dir / f"{job_id}{suffix}"
        shutil.copy2(src, dest)
        logger.info("Saved GLB → %s  (%.1f KB)", dest, dest.stat().st_size / 1024)
        return str(dest)

    # ── public API (async) ───────────────────────────────────────────────────

    async def generate(self, prompt: str, job_id: str) -> str:
        """
        Run the two-step pipeline in a thread pool so we don't block the
        FastAPI event loop (gradio_client is synchronous).
        """
        loop = asyncio.get_running_loop()

        async with self._lock:
            # Init clients once; subsequent calls skip this block immediately
            await loop.run_in_executor(None, self._get_flux_client)
            await loop.run_in_executor(None, self._get_hunyuan_client)

        try:
            # Step 1: text → image
            img_path = await loop.run_in_executor(
                None,
                functools.partial(self._generate_image_sync, prompt),
            )

            # Step 2: image → GLB
            glb_path = await loop.run_in_executor(
                None,
                functools.partial(self._generate_3d_sync, img_path, job_id),
            )
            return glb_path

        except ProviderError:
            raise  # already a friendly message
        except Exception as exc:
            msg = str(exc)
            # Surface the most common failure modes clearly
            if "queue is full" in msg.lower():
                raise ProviderError(
                    "The AI model is currently overloaded. Please try again in a minute."
                )
            if "RuntimeError" in msg:
                raise ProviderError(
                    "The 3D generation Space hit an error (likely GPU out-of-memory). "
                    "Please try again."
                )
            if "429" in msg or "rate limit" in msg.lower():
                raise ProviderError(
                    "HF Space rate limit reached. Wait a minute and try again."
                )
            logger.exception("Unexpected provider error")
            raise ProviderError(f"Generation failed: {msg[:200]}")
