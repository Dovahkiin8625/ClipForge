"""The jobs the service runs.

A job is a thread that separates one file. The client polls it for progress
and fetches the result when it is done.
"""

from __future__ import annotations

import shutil
import threading
import uuid
from pathlib import Path
from typing import Optional

from .protocol import JobInfo
from .providers import Cancelled, default_provider, get


class Job:
    """One separation, from the source file to the finished WAV."""

    def __init__(
        self,
        job_id: str,
        source: Path,
        work_dir: Path,
        provider_id: Optional[str] = None,
        model: Optional[str] = None,
    ) -> None:
        self.id = job_id
        self.source = source
        self.work_dir = work_dir
        self.provider_id = provider_id
        self.model = model

        self.status = "queued"
        self.progress = 0.0
        self.message = ""
        self.result_path: Optional[Path] = None
        self.duration: Optional[float] = None
        self.error: Optional[str] = None

        self._cancel = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True)

    # -- life cycle ----------------------------------------------------

    def start(self) -> None:
        self._thread.start()

    def cancel(self) -> None:
        self._cancel.set()
        self.message = "正在取消…"

    def wait(self, timeout: Optional[float] = None) -> None:
        self._thread.join(timeout)

    @property
    def cancelled(self) -> bool:
        return self._cancel.is_set()

    # -- the work ------------------------------------------------------

    def _run(self) -> None:
        provider = get(self.provider_id) if self.provider_id else default_provider()
        if provider is None:
            self._fail("没有可用的分离方式")
            return

        self.provider_id = provider.id
        self.status = "running"
        self.message = f"正在使用 {provider.label} 分离…"

        try:
            result = provider.separate(
                self.source,
                self.work_dir,
                self.model,
                self._report,
                self._cancel,
            )
            if self._cancel.is_set():
                raise Cancelled()
            self.result_path = result
            self.duration = probe_duration(result)
            self.progress = 1.0
            self.message = "完成"
            self.status = "done"
        except Cancelled:
            self.status = "cancelled"
            self.message = "已取消"
        except Exception as err:  # noqa: BLE001 - the message reaches the client
            self._fail(str(err))

    def _report(self, progress: float, message: str) -> None:
        self.progress = max(0.0, min(1.0, float(progress)))
        self.message = message

    def _fail(self, message: str) -> None:
        self.status = "error"
        self.error = message
        self.message = message

    # -- reporting -----------------------------------------------------

    def info(self) -> JobInfo:
        return JobInfo(
            job_id=self.id,
            status=self.status,
            progress=self.progress,
            message=self.message,
            provider=self.provider_id,
            model=self.model,
            result_path=str(self.result_path) if self.result_path else None,
            file_id=self.id if self.result_path else None,
            duration=self.duration,
            error=self.error,
        )


class JobManager:
    """Keeps the jobs and their files."""

    def __init__(self, root: Path) -> None:
        self.root = root
        self.root.mkdir(parents=True, exist_ok=True)
        self._jobs: dict[str, Job] = {}
        self._lock = threading.Lock()

    def create(
        self,
        source: Path,
        provider_id: Optional[str] = None,
        model: Optional[str] = None,
    ) -> Job:
        job_id = uuid.uuid4().hex
        work_dir = self.root / job_id
        work_dir.mkdir(parents=True, exist_ok=True)

        # The upload is moved into the job's own directory before the job
        # starts, so that the worker never sees a half-written file.
        target = work_dir / f"source{source.suffix or '.wav'}"
        if source.resolve() != target.resolve():
            source.replace(target)

        job = Job(job_id, target, work_dir, provider_id, model)
        with self._lock:
            self._jobs[job_id] = job
        job.start()
        return job

    def get(self, job_id: str) -> Optional[Job]:
        with self._lock:
            return self._jobs.get(job_id)

    def result_file(self, job_id: str) -> Optional[Path]:
        job = self.get(job_id)
        if job is None or job.result_path is None:
            return None
        if not job.result_path.exists():
            return None
        return job.result_path

    def remove(self, job_id: str) -> None:
        """Drops a finished job and its files."""
        with self._lock:
            job = self._jobs.pop(job_id, None)
        if job is None:
            return
        shutil.rmtree(job.work_dir, ignore_errors=True)


def probe_duration(path: Path) -> Optional[float]:
    """Asks ffprobe how long a file is; None when it cannot say."""
    from shutil import which

    ffprobe = which("ffprobe")
    if ffprobe is None:
        return None
    import subprocess

    try:
        result = subprocess.run(
            [
                ffprobe,
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "default=noprint_wrappers=1:nokey=1",
                str(path),
            ],
            capture_output=True,
            text=True,
            timeout=15,
        )
        if result.returncode != 0:
            return None
        return float(result.stdout.strip())
    except (ValueError, OSError, subprocess.SubprocessError):
        return None
