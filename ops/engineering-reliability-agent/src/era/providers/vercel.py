from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from datetime import UTC, datetime, timedelta
from typing import Any
from urllib.parse import quote, urlencode

from .http import JsonGetTransport, ProviderReadError, UrlLibJsonTransport


_IDENTIFIER = re.compile(r"[A-Za-z0-9_.-]{3,160}")
_SINCE = re.compile(r"([1-9][0-9]*)([mh])")


def _mapping(value: Any) -> Mapping[str, Any]:
    return value if isinstance(value, Mapping) else {}


def _sequence(value: Any) -> Sequence[Any]:
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return value
    return ()


def _timestamp(value: Any) -> str:
    try:
        raw = float(value)
    except (TypeError, ValueError):
        return datetime.now(UTC).isoformat()
    if raw > 10_000_000_000:
        raw /= 1_000
    return datetime.fromtimestamp(raw, UTC).isoformat()


def _timestamp_milliseconds(value: Any) -> int | None:
    try:
        raw = float(value)
    except (TypeError, ValueError):
        return None
    if raw <= 10_000_000_000:
        raw *= 1_000
    return int(raw)


def _status_code(value: Any) -> int | None:
    try:
        status = int(value)
    except (TypeError, ValueError):
        return None
    return status if 100 <= status <= 599 else None


class VercelApiSource:
    """GET-only access to deployments and bounded deployment events."""

    def __init__(
        self,
        token: str,
        *,
        team_id: str | None = None,
        transport: JsonGetTransport | None = None,
    ) -> None:
        if not token or "\n" in token or "\r" in token:
            raise ValueError("A valid Vercel read token is required")
        if team_id and not _IDENTIFIER.fullmatch(team_id):
            raise ValueError("Vercel team ID is invalid")
        self._token = token
        self._team_id = team_id
        self._transport = transport or UrlLibJsonTransport(
            frozenset({"api.vercel.com"})
        )

    def _headers(self) -> dict[str, str]:
        return {
            "Accept": "application/json",
            "Authorization": f"Bearer {self._token}",
            "User-Agent": "BaristaMatch-ERA/0.1",
        }

    async def _get(self, path: str, query: Mapping[str, object]) -> Any:
        values = dict(query)
        if self._team_id:
            values["teamId"] = self._team_id
        url = f"https://api.vercel.com{path}?{urlencode(values)}"
        return await self._transport.get_json(url, headers=self._headers())

    @staticmethod
    def _validate(project_id: str, environment: str, limit: int) -> None:
        if not _IDENTIFIER.fullmatch(project_id):
            raise ValueError("Vercel project ID is invalid")
        if environment not in {"production", "preview"}:
            raise ValueError("Vercel environment must be production or preview")
        if not 1 <= limit <= 100:
            raise ValueError("Vercel result limit must be between 1 and 100")

    async def _deployments(
        self, project_id: str, *, environment: str, limit: int
    ) -> list[Mapping[str, Any]]:
        self._validate(project_id, environment, limit)
        payload = _mapping(
            await self._get(
                "/v6/deployments",
                {
                    "projectId": project_id,
                    "target": environment,
                    "limit": limit,
                },
            )
        )
        deployments = payload.get("deployments")
        if not isinstance(deployments, list):
            raise ProviderReadError("Vercel returned an invalid deployment list")
        return [item for item in deployments if isinstance(item, Mapping)][:limit]

    async def list_failed_deployments(
        self, project_id: str, *, environment: str, since: str, limit: int
    ) -> list[Mapping[str, Any]]:
        deployments = await self._deployments(
            project_id, environment=environment, limit=limit
        )
        since_ms = self._since_milliseconds(since)
        failures: list[Mapping[str, Any]] = []
        for item in deployments:
            state = str(item.get("state") or item.get("readyState") or "").upper()
            if state != "ERROR":
                continue
            created = item.get("created") or item.get("createdAt")
            created_ms = _timestamp_milliseconds(created)
            if created_ms is None or created_ms < since_ms:
                continue
            deployment_id = str(item.get("uid") or item.get("id") or "")
            metadata = _mapping(item.get("meta"))
            failures.append(
                {
                    "id": f"vercel-deployment-{deployment_id or len(failures)}",
                    "occurred_at": _timestamp(created),
                    "summary": "Vercel deployment failed",
                    "deployment_id": deployment_id or None,
                    "commit_sha": metadata.get("githubCommitSha"),
                    "state": state,
                }
            )
        return failures

    @staticmethod
    def _since_milliseconds(value: str) -> int:
        match = _SINCE.fullmatch(value)
        if not match:
            raise ValueError("Vercel lookback must use a value such as 30m or 1h")
        amount = int(match.group(1))
        delta = (
            timedelta(minutes=amount)
            if match.group(2) == "m"
            else timedelta(hours=amount)
        )
        if delta > timedelta(hours=24):
            raise ValueError("Vercel lookback cannot exceed 24 hours")
        return int((datetime.now(UTC) - delta).timestamp() * 1_000)

    async def list_runtime_errors(
        self,
        project_id: str,
        *,
        environment: str,
        since: str,
        limit: int,
    ) -> list[Mapping[str, Any]]:
        self._validate(project_id, environment, limit)
        since_ms = self._since_milliseconds(since)
        deployments = await self._deployments(
            project_id, environment=environment, limit=min(limit, 10)
        )
        grouped: dict[tuple[str, str], dict[str, Any]] = {}
        for deployment in deployments:
            state = str(
                deployment.get("state") or deployment.get("readyState") or ""
            ).upper()
            deployment_id = str(deployment.get("uid") or deployment.get("id") or "")
            if state != "READY" or not _IDENTIFIER.fullmatch(deployment_id):
                continue
            events = await self._get(
                f"/v3/deployments/{quote(deployment_id)}/events",
                {
                    "direction": "backward",
                    "follow": 0,
                    "limit": limit,
                    "since": since_ms,
                    "statusCode": "5xx",
                },
            )
            if not isinstance(events, list):
                continue
            metadata = _mapping(deployment.get("meta"))
            for event in events:
                if not isinstance(event, Mapping):
                    continue
                payload = _mapping(event.get("payload"))
                proxy = _mapping(payload.get("proxy"))
                info = _mapping(payload.get("info"))
                status = _status_code(
                    payload.get("statusCode") or proxy.get("statusCode")
                )
                if status is None or status < 500:
                    continue
                route = str(proxy.get("path") or info.get("path") or "/")
                route = route.split("?", 1)[0][:300]
                key = (deployment_id, route)
                occurred_at = _timestamp(
                    event.get("created")
                    or payload.get("created")
                    or proxy.get("timestamp")
                )
                record = grouped.setdefault(
                    key,
                    {
                        "occurred_at": occurred_at,
                        "route": route,
                        "status_code": status,
                        "deployment_id": deployment_id,
                        "commit_sha": metadata.get("githubCommitSha"),
                        "count": 0,
                    },
                )
                record["count"] = int(record["count"]) + 1
                if occurred_at > str(record["occurred_at"]):
                    record["occurred_at"] = occurred_at
                if len(grouped) >= limit:
                    break
            if len(grouped) >= limit:
                break

        errors: list[Mapping[str, Any]] = []
        for index, record in enumerate(grouped.values()):
            errors.append(
                {
                    "id": f"vercel-runtime-{index}",
                    "summary": "Vercel runtime returned a server error",
                    **record,
                }
            )
        return errors
