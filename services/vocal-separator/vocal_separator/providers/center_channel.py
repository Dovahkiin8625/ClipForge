"""Lifts the voice out with the middle channel — no model, no training.

A voice is usually mixed into the middle of the stereo field, so what left
and right have in common — their average — holds most of it. Averaging the
two sides cancels out whatever sits at the edges.

It is an approximation: a voice panned to one side is lost, and so is
anything else that lives in the middle. But it needs nothing but FFmpeg and
it is instant, which makes it the provider of last resort.
"""

from __future__ import annotations

import subprocess
import threading
from pathlib import Path
from typing import Optional

from .base import ModelSpec, Report, VocalProvider


class CenterChannelProvider(VocalProvider):
    id = "center-channel"
    label = "FFmpeg 中置声道提取"
    kind = "filter"

    def models(self) -> list[ModelSpec]:
        return []

    def available(self) -> tuple[bool, Optional[str]]:
        from shutil import which

        if which("ffmpeg") is None:
            return False, "未找到 FFmpeg"
        return True, None

    def separate(
        self,
        source: Path,
        out_dir: Path,
        model: Optional[str],
        report: Report,
        cancel: threading.Event,
    ) -> Path:
        from shutil import which

        ffmpeg = which("ffmpeg")
        if ffmpeg is None:
            raise RuntimeError("未找到 FFmpeg")

        output = out_dir / "vocals-center.wav"
        report(0.05, "正在提取中置声道…")

        process = subprocess.Popen(
            [
                ffmpeg,
                "-hide_banner",
                "-nostdin",
                "-y",
                "-i",
                str(source),
                "-af",
                "aformat=channel_layouts=stereo,pan=stereo|c0=0.5*c0+0.5*c1|c1=0.5*c0+0.5*c1",
                "-c:a",
                "pcm_s16le",
                str(output),
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
        )

        while process.poll() is None:
            if cancel.is_set():
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                from .base import Cancelled

                raise Cancelled()
            cancel.wait(0.2)

        if process.returncode != 0:
            stderr = process.stderr.read() if process.stderr else ""
            raise RuntimeError(f"FFmpeg 失败（退出码 {process.returncode}）：{stderr[-300:]}")

        report(0.98, "中置声道提取完成")
        return output
