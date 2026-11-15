"""The wire format of the separation service.

It mirrors `src/shared/vocals.ts` in the ClipForge repository. The two must
be changed together: the app and the service are separate programs that only
ever meet over HTTP.
"""

from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, Field


class ModelInfo(BaseModel):
    """One model a provider can run."""

    id: str
    label: str


class ProviderInfo(BaseModel):
    """One way of separating the voice out of a recording."""

    id: str
    label: str
    # "model" for a trained network, "filter" for classic signal processing.
    kind: str = "model"
    models: list[ModelInfo] = Field(default_factory=list)
    available: bool = True
    reason: Optional[str] = None


class HealthInfo(BaseModel):
    status: str = "ok"
    version: str
    providers: list[ProviderInfo] = Field(default_factory=list)


class JobInfo(BaseModel):
    job_id: str
    status: str = "queued"
    progress: float = 0.0
    message: str = ""
    provider: Optional[str] = None
    model: Optional[str] = None
    result_path: Optional[str] = None
    file_id: Optional[str] = None
    duration: Optional[float] = None
    error: Optional[str] = None
