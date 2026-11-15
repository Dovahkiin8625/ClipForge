"""The HTTP face of the separation service.

The service is an ordinary program that ClipForge talks to over HTTP. It
knows nothing about timelines, clips or projects: it takes an audio file and
gives back one with the voice in it.
"""

from __future__ import annotations

import os
import tempfile
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse

from .jobs import JobManager
from .protocol import HealthInfo, JobInfo, ModelInfo, ProviderInfo
from .providers import all_providers

VERSION = "1.0.0"

app = FastAPI(title="ClipForge Vocal Separator", version=VERSION)

WORK_DIR = Path(os.environ.get("VOCAL_SEPARATOR_WORK", tempfile.gettempdir())) / "vocal-separator"
jobs = JobManager(WORK_DIR)


@app.get("/health")
def health() -> HealthInfo:
    """Tells the client whether the service is up and what it can do."""
    return HealthInfo(status="ok", version=VERSION, providers=provider_infos())


@app.get("/providers")
def providers() -> list[ProviderInfo]:
    return provider_infos()


@app.post("/separate")
def separate(
    file: UploadFile = File(...),
    provider: Optional[str] = Form(default=None),
    model: Optional[str] = Form(default=None),
    name: Optional[str] = Form(default=None),
) -> dict:
    """Starts a separation and hands back the id of the job."""
    suffix = Path(file.filename or "source.wav").suffix or ".wav"

    # The upload is written to a temporary file first; the job manager moves
    # it into the job's own directory before the work begins.
    handle = tempfile.NamedTemporaryFile(suffix=suffix, dir=WORK_DIR, delete=False)
    try:
        while chunk := file.file.read(1024 * 1024):
            handle.write(chunk)
    finally:
        handle.close()

    job = jobs.create(Path(handle.name), provider_id=provider, model=model)

    return {"job_id": job.id, "status": job.status}


@app.get("/jobs/{job_id}")
def job_info(job_id: str) -> JobInfo:
    job = jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="找不到任务")
    return job.info()


@app.post("/jobs/{job_id}/cancel")
def cancel_job(job_id: str) -> dict:
    job = jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="找不到任务")
    job.cancel()
    return {"job_id": job.id, "status": job.status}


@app.get("/files/{file_id}")
def download(file_id: str) -> FileResponse:
    """Hands the separated audio back to the client."""
    path = jobs.result_file(file_id)
    if path is None:
        raise HTTPException(status_code=404, detail="找不到结果文件")
    return FileResponse(path, media_type="audio/wav", filename=path.name)


def provider_infos() -> list[ProviderInfo]:
    infos: list[ProviderInfo] = []
    for provider in all_providers():
        available, reason = provider.available()
        infos.append(
            ProviderInfo(
                id=provider.id,
                label=provider.label,
                kind=provider.kind,
                models=[
                    ModelInfo(id=spec.id, label=spec.label) for spec in provider.models()
                ],
                available=available,
                reason=reason,
            )
        )
    return infos
