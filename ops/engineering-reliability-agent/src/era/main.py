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

from .alerts import deliver_response_alert
from .config import AgentConfig
from .live import LiveCollectionPlan, build_live_plan, run_live_plan
from .models import IncidentEvidence, RecentChange
from .monitor import run_monitoring_cycle
from .providers.vercel import VercelApiSource
from .response import build_response_package
from .verification import wait_for_production_revision
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


def _load_json_object(path_value: str) -> dict[str, Any]:
    path = Path(path_value).resolve(strict=True)
    if not path.is_file() or path.stat().st_size > MAX_INPUT_BYTES:
        raise ValueError("Input must be a JSON file no larger than 2 MB")
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("Input JSON must be an object")
    return payload


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


def _live_plan_from_args(args: argparse.Namespace) -> LiveCollectionPlan:
    return build_live_plan(
        provider_names=args.provider,
        environment_name=args.environment,
        environment=os.environ,
        health_urls=args.health_url,
        supabase_services=args.supabase_service,
        limit=args.limit,
        lookback=args.lookback,
    )


async def _run_live_collection(args: argparse.Namespace) -> None:
    plan = _live_plan_from_args(args)
    result = await run_live_plan(plan)
    _write_json(result.to_dict())


async def _run_monitoring(args: argparse.Namespace) -> int:
    plan = _live_plan_from_args(args)
    result = await run_monitoring_cycle(plan)
    _write_json(result.to_dict())
    return result.exit_code


def _run_prepare_response(args: argparse.Namespace) -> None:
    payloads = [_load_json_object(path) for path in args.input]
    package = build_response_package(
        payloads,
        repository=os.getenv("GITHUB_REPOSITORY", "unknown/unknown"),
        run_id=os.getenv("GITHUB_RUN_ID", "unknown"),
        source_sha=os.getenv("GITHUB_SHA", "unknown"),
    )
    _write_json(package.to_dict())


def _run_notify(args: argparse.Namespace) -> int:
    package = _load_json_object(args.input)
    result = deliver_response_alert(package, os.environ)
    _write_json(result.to_dict())
    return result.exit_code


async def _run_wait_deployment(args: argparse.Namespace) -> int:
    token = os.getenv("VERCEL_READ_TOKEN", "").strip()
    project_id = os.getenv("VERCEL_PROJECT_ID", "").strip()
    team_id = os.getenv("VERCEL_TEAM_ID", "").strip()
    if not token or not project_id or not team_id:
        raise RuntimeError("Read-only Vercel configuration is required")
    source = VercelApiSource(token, team_id=team_id)
    result = await wait_for_production_revision(
        source,
        project_id,
        args.commit,
        attempts=args.attempts,
        delay_seconds=args.delay,
    )
    _write_json(result.to_dict())
    return result.exit_code


class _HealthHandler(BaseHTTPRequestHandler):
    server_version = "BaristaMatchERA/0.2"

    def do_GET(self) -> None:  # noqa: N802
        if urlsplit(self.path).path != "/health":
            self._json_response(HTTPStatus.NOT_FOUND, {"error": "not_found"})
            return
        self._json_response(
            HTTPStatus.OK,
            {
                "status": "ok",
                "service": "engineering-reliability-agent",
                "version": "0.2.0",
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
                    "path": urlsplit(self.path).path[:300],
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


def _add_live_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--provider",
        action="append",
        required=True,
        choices=("health", "github", "vercel", "supabase"),
    )
    parser.add_argument(
        "--environment",
        required=True,
        choices=("production", "preview"),
    )
    parser.add_argument("--health-url", action="append", default=[])
    parser.add_argument(
        "--supabase-service",
        action="append",
        default=[],
        choices=("api", "postgres", "auth", "storage", "realtime", "edge-function"),
    )
    parser.add_argument("--lookback", default="1h")
    parser.add_argument("--limit", default=25, type=int)


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
    live = subparsers.add_parser(
        "collect-live",
        help="Collect sanitized evidence using read-only provider operations.",
    )
    _add_live_arguments(live)
    monitor = subparsers.add_parser(
        "monitor",
        help=(
            "Collect and classify sanitized evidence without a model or write action."
        ),
    )
    _add_live_arguments(monitor)
    response = subparsers.add_parser(
        "prepare-response",
        help="Build a sanitized owner-review response package from monitor results.",
    )
    response.add_argument(
        "--input",
        action="append",
        required=True,
        help="Monitoring result JSON path. May be supplied more than once.",
    )
    notify = subparsers.add_parser(
        "notify",
        help="Send an owner-approved P0/P1 email from a response package.",
    )
    notify.add_argument("--input", required=True, help="Response package JSON path.")
    deployment = subparsers.add_parser(
        "wait-deployment",
        help="Wait for the exact reviewed commit to become READY in production.",
    )
    deployment.add_argument("--commit", required=True, help="Expected Git commit SHA.")
    deployment.add_argument("--attempts", type=int, default=60)
    deployment.add_argument("--delay", type=float, default=10)
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
        elif command == "collect-live":
            asyncio.run(_run_live_collection(args))
        elif command == "monitor":
            raise SystemExit(asyncio.run(_run_monitoring(args)))
        elif command == "prepare-response":
            _run_prepare_response(args)
        elif command == "notify":
            raise SystemExit(_run_notify(args))
        elif command == "wait-deployment":
            raise SystemExit(asyncio.run(_run_wait_deployment(args)))
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
