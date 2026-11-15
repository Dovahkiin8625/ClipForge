"""Demucs — the neural network that separates a song into voice and music.

Demucs is a Python package; the provider runs it as a child process so that
a missing installation is a plain "not available" rather than a crash. The
first run downloads the model weights, which takes a while and needs a
network connection.
"""

from __future__ import annotations

import importlib.util
import re
import subprocess
import sys
import threading
from pathlib import Path
from typing import Optional

from .base import Cancelled, ModelSpec, Report, VocalProvider

# Demucs writes its progress as " 42%|####  | 42/100 [00:07<00:09]".
PROGRESS = re.compile(r"(\d{1,3})%")


class DemucsProvider(VocalProvider):
    id = "demucs"
    label = "Demucs 神经网络"
    kind = "model"

    MODELS = [
        ModelSpec("htdemucs", "htdemucs（通用，混合较好的）"),
        ModelSpec("htdemucs_ft", "htdemucs_ft（更精细，更慢）"),
        ModelSpec("mdx_extra", "mdx_extra（人声更干净）"),
    ]

    def models(self) -> list[ModelSpec]:
        return list(self.MODELS)

    def available(self) -> tuple[bool, Optional[str]]:
        if importlib.util.find_spec("demucs") is None:
            return False, "未安装 demucs（pip install demucs）"
        return True, None

    def separate(
        self,
        source: Path,
        out_dir: Path,
        model: Optional[str],
        report: Report,
        cancel: threading.Event,
    ) -> Path:
        if not shutil_which_ffmpeg():
            return self._separate_without_ffmpeg(source, out_dir, model, report, cancel)

        name = model or self.MODELS[0].id
        command = [
            sys.executable,
            "-m",
            "demucs",
            "--two-stems=vocals",
            "-n",
            name,
            "-o",
            str(out_dir),
            str(source),
        ]
        report(0.02, f"正在运行 Demucs（{name}）…")

        process = subprocess.Popen(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
        )

        lines: list[str] = []

        def read_stderr() -> None:
            assert process.stderr is not None
            for line in process.stderr:
                lines.append(line)
                match = PROGRESS.search(line)
                if match:
                    percent = min(100, int(match.group(1)))
                    report(0.02 + (percent / 100) * 0.9, f"正在分离人声… {percent}%")

        reader = threading.Thread(target=read_stderr, daemon=True)
        reader.start()

        while process.poll() is None:
            if cancel.is_set():
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                raise Cancelled()
            cancel.wait(0.2)

        reader.join(timeout=2)
        if process.returncode != 0:
            tail = "".join(lines[-12:]).strip()
            raise RuntimeError(f"Demucs 失败（退出码 {process.returncode}）：{tail}")

        vocals = self._find_vocals(out_dir)
        if vocals is None:
            raise RuntimeError("Demucs 没有产出人声文件")
        report(0.98, "人声分离完成")
        return vocals

    def _separate_without_ffmpeg(
        self,
        source: Path,
        out_dir: Path,
        model: Optional[str],
        report: Report,
        cancel: threading.Event,
    ) -> Path:
        """Demucs needs FFmpeg to decode the input; without it there is none."""
        raise RuntimeError("Demucs 需要 FFmpeg 才能读取音频，请先安装 FFmpeg")

    @staticmethod
    def _find_vocals(out_dir: Path) -> Optional[Path]:
        candidates = sorted(out_dir.rglob("vocals.wav"), key=lambda p: p.stat().st_mtime, reverse=True)
        return candidates[0] if candidates else None


def shutil_which_ffmpeg() -> Optional[str]:
    from shutil import which

    return which("ffmpeg")
