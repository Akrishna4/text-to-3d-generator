"""
providers/__init__.py
---------------------
Factory function that reads the PROVIDER env var and returns the correct
implementation. Adding a new backend = add a new elif branch here.

Currently supported:
  hunyuan  (default) – FLUX.1-schnell → Hunyuan3D-2 via HF Spaces
"""
from __future__ import annotations

import os
import pathlib

from providers.base import Provider


def get_provider(output_dir: pathlib.Path) -> Provider:
    """
    Instantiate and return the selected provider.

    The PROVIDER env var controls which backend is used.
    All providers receive the output_dir where they should save GLB files.
    """
    name = os.environ.get("PROVIDER", "hunyuan").lower()

    if name == "hunyuan":
        from providers.hunyuan import HunyuanProvider
        hf_token = os.environ.get("HF_TOKEN", "")
        if not hf_token:
            raise RuntimeError(
                "PROVIDER=hunyuan requires HF_TOKEN to be set in the environment."
            )
        return HunyuanProvider(hf_token=hf_token, output_dir=output_dir)

    raise ValueError(
        f"Unknown PROVIDER={name!r}. Valid options: hunyuan"
    )
