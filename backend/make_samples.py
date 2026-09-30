"""
make_samples.py
---------------
Generates 3 pre-baked sample GLBs using the Hunyuan provider and saves
them to backend/samples/. Run once before deploying.

These samples are served by GET /api/samples and power the
"Try an example" buttons in the UI, so the app demos even if the AI
provider is sleeping or the queue is long.

Usage:
    cd /path/to/one
    source .venv/bin/activate
    python backend/make_samples.py
"""
import asyncio
import pathlib
import shutil
import os
from dotenv import load_dotenv

load_dotenv(pathlib.Path(__file__).parent / ".env")

SAMPLES_DIR = pathlib.Path(__file__).parent / "samples"
SAMPLES_DIR.mkdir(exist_ok=True)

# (slug, prompt) — slug becomes the filename and display label
SAMPLE_PROMPTS = [
    ("ceramic_teapot",  "a small ceramic teapot, white background, studio lighting, isolated object"),
    ("wooden_chair",    "a wooden chair, white background, studio lighting, isolated object"),
    ("space_helmet",    "an astronaut helmet, white background, studio lighting, isolated object"),
]


async def make_samples():
    from providers.hunyuan import HunyuanProvider

    hf_token = os.environ.get("HF_TOKEN", "")
    if not hf_token:
        raise SystemExit("HF_TOKEN not found in backend/.env")

    # Use a temp dir so HunyuanProvider saves files there,
    # then we copy to the samples dir with the right names.
    import tempfile
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = pathlib.Path(tmp)
        provider = HunyuanProvider(hf_token=hf_token, output_dir=tmp_path)

        for slug, prompt in SAMPLE_PROMPTS:
            dest = SAMPLES_DIR / f"{slug}.glb"
            if dest.exists():
                print(f"  ✅ Already exists: {dest.name} — skipping")
                continue

            print(f"\n  Generating: {slug!r}")
            print(f"  Prompt: {prompt!r}")
            try:
                glb_path = await provider.generate(prompt, job_id=slug)
                shutil.copy2(glb_path, dest)
                size_kb = dest.stat().st_size / 1024
                print(f"  ✅ Saved → {dest}  ({size_kb:.0f} KB)")
            except Exception as e:
                print(f"  ❌ Failed: {e}")

    print("\nDone. Files in backend/samples/:")
    for f in sorted(SAMPLES_DIR.glob("*.glb")):
        print(f"  {f.name}  ({f.stat().st_size/1024:.0f} KB)")


if __name__ == "__main__":
    asyncio.run(make_samples())
