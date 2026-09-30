"""
providers/base.py
-----------------
Abstract Provider interface. Every backend (e.g., Hunyuan3D) must
implement generate() and return a local path to a valid GLB file.

The backend selects which implementation to use via the PROVIDER env var.
This lets you swap providers at demo time without touching application code.
New backends can be added by implementing this interface and registering
them in providers/__init__.py.
"""
from abc import ABC, abstractmethod


class Provider(ABC):
    """Text-to-3D provider contract."""

    @abstractmethod
    async def generate(self, prompt: str, job_id: str) -> str:
        """
        Generate a 3D model from a text prompt.

        Args:
            prompt:  The user's text description.
            job_id:  Unique job identifier (used to name the output file).

        Returns:
            Absolute path to the generated GLB file on local disk.

        Raises:
            ProviderError: if generation fails for any reason.
        """
        ...


class ProviderError(Exception):
    """Raised when a provider fails. Message is shown to the user."""
    pass
