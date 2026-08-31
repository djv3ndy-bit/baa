from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from .config import AgentConfig
from .models import IncidentEvidence, RecentChange
from .workflows.investigate import investigate


MAX_INPUT_BYTES = 2_000_000


def _load_payload(path_value: str) -> tuple[list[IncidentEvidence], list[RecentChange]]:
    path = Path(path_value).resolve(strict=True)
    if not path.is_file() or path.stat().st_size > MAX_INPUT_BYTES:
        raise ValueError("Input must be a JSON file no larger than 2 MB")
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("Input JSON must be an object")
    evidence = [
        IncidentEvidence.from_mapping(item) for item in payload.get("evidence") or []
    ]
    changes = [RecentChange.from_mapping(item) for item in payload.get("changes") or []]
    return evidence, changes


def _write_json(value: Any) -> None:
    print(json.dumps(value, indent=2, sort_keys=True))


async def _run_investigation(path: str, *, use_model: bool) -> None:
    config = AgentConfig.from_environment()
    if use_model:
        config.require_openai()
    evidence, changes = _load_payload(path)
    result = await investigate(
        evidence, changes, use_model=use_model, model=config.model
    )
    _write_json(result.to_dict())


class _HealthHandler(BaseHTTPRequestHandler):
    server_version = "BaristaMatchERA/0.1"

    def do_GET(self) -> None:  # noqa: N802
        if urlsplit(self.path).path != "/health":
            self._json_response(HTTPStatus.NOT_FOUND, {"error": "not_found"})
            return
        self._json_response(
            HTTPStatus.OK,
            {
                "status": "ok",
                "service": "engineering-reliability-agent",
                "version": "0.1.0",
                "production_writes_enabled": False,
            },
        )

    def do_POST(self) -> None:  # noqa: N802
        self._json_response(
            HTTPStatus.METHOD_NOT_ALLOWED, {"error": "method_not_allowed"}
        )

    def _json_response(self, status: HTTPStatus, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        self.send_response(status.value)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args: Any) -> None:
        print(
            json.dumps(
                {
                    "level": "info",
                    "message": "readiness_request",
                    "path": urlsplit(self.path).path,
                    "detail": format % args,
                },
                separators=(",", ":"),
            )
        )


def serve() -> None:
    host = os.getenv("ERA_BIND_HOST", "0.0.0.0")
    port = int(os.getenv("PORT", "8080"))
    if not 1 <= port <= 65_535:
        raise ValueError("PORT must be between 1 and 65535")
    server = ThreadingHTTPServer((host, port), _HealthHandler)
    print(
        json.dumps(
            {
                "level": "info",
                "message": "readiness_server_started",
                "port": port,
                "production_writes_enabled": False,
            },
            separators=(",", ":"),
        )
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="BaristaMatch Engineering & Reliability Agent"
    )
    subparsers = parser.add_subparsers(dest="command")
    for command, help_text in (
        ("dry-run", "Run deterministic investigation without network or model access."),
        ("analyze", "Run deterministic investigation plus one model explanation."),
    ):
        subparser = subparsers.add_parser(command, help=help_text)
        subparser.add_argument(
            "--input", required=True, help="Incident fixture JSON path."
        )
    subparsers.add_parser("serve", help="Start the readiness-only HTTP service.")
    return parser


def main() -> None:
    parser = _parser()
    args = parser.parse_args()
    command = args.command
    if command is None and os.getenv("PORT"):
        command = "serve"
    try:
        if command == "serve":
            serve()
        elif command == "dry-run":
            asyncio.run(_run_investigation(args.input, use_model=False))
        elif command == "analyze":
            asyncio.run(_run_investigation(args.input, use_model=True))
        else:
            parser.print_help()
    except Exception as error:
        print(
            json.dumps(
                {
                    "error": "operation_failed",
                    "error_type": type(error).__name__,
                },
                separators=(",", ":"),
            ),
            file=sys.stderr,
        )
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
