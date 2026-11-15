"""What every provider has to be able to do.

A provider takes a WAV file and returns a WAV file with the voice in it.
Everything else — cutting the clip out of its source, naming the result,
keeping it around — belongs to the job manager, which is why a new provider
is such a small piece of code.
"""

from __future__ import annotations

import threading
from abc import ABC, abstractmethod
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Optional

# Called with a progress (0..1) and a message for the user.
Report = Callable[[float, str], None]


class Cancelled(Exception):
    """Raised when the user stops a running job."""


@dataclass(frozen=True)
class ModelSpec:
    id: str
    label: str


class VocalProvider(ABC):
    """One way of lifting the voice out of a recording."""

    id: str = ""
    label: str = ""
    kind: str = "model"

    @abstractmethod
    def models(self) -> list[ModelSpec]:
        """The models this provider can run."""

    @abstractmethod
    def available(self) -> tuple[bool, Optional[str]]:
        """Whether the provider can run right now, and why not if it cannot."""

    @abstractmethod
    def separate(
        self,
        source: Path,
        out_dir: Path,
        model: Optional[str],
        report: Report,
        cancel: threading.Event,
    ) -> Path:
        """Separates the voice out of `source` and returns the WAV file."""

    def _check_cancelled(self, cancel: threading.Event) -> None:
        if cancel.is_set():
            raise Cancelled()
