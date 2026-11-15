"""Starts the separation service.

    python run.py --host 127.0.0.1 --port 8777
"""

from __future__ import annotations

import argparse

import uvicorn


def main() -> None:
    parser = argparse.ArgumentParser(description="ClipForge 人声分离服务")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8777)
    parser.add_argument("--reload", action="store_true", help="代码改动后自动重启")
    args = parser.parse_args()

    uvicorn.run(
        "vocal_separator.app:app",
        host=args.host,
        port=args.port,
        reload=args.reload,
    )


if __name__ == "__main__":
    main()
