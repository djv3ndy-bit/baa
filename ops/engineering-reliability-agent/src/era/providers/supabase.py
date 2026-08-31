from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from datetime import UTC, datetime, timedelta
from typing import Any
from urllib.parse import quote, urlencode

from .http import JsonGetTransport, ProviderReadError, UrlLibJsonTransport


_PROJECT_REF = re.compile(r"[a-z0-9-]{6,40}")
_LOG_SOURCES: Mapping[str, str] = {
    "api": "edge_logs",
    "auth": "auth_logs",
    "edge-function": "function_edge_logs",
    "postgres": "postgres_logs",
    "realtime": "realtime_logs",
    "storage": "storage_logs",
}


def _sequence(value: Any) -> Sequence[Any]:
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return value
    return ()


def _status_code(value: Any) -> int | None:
    try:
        status = int(value)
    except (TypeError, ValueError):
        return None
    return status if 100 <= status <= 599 else None


class SupabaseManagementSource:
    """Read sanitized error metadata from the unified Supabase log stream."""

    def __init__(
        self,
        token: str,
        *,
        lookback_minutes: int = 60,
        transport: JsonGetTransport | None = None,
    ) -> None:
        if not token or "\n" in token or "\r" in token:
            raise ValueError("A valid Supabase analytics token is required")
        if not 1 <= lookback_minutes <= 1_440:
            raise ValueError("Supabase log lookback must be between 1 and 1440 minutes")
        self._token = token
        self._lookback = timedelta(minutes=lookback_minutes)
        self._transport = transport or UrlLibJsonTransport(
            frozenset({"api.supabase.com"})
        )

    def _headers(self) -> dict[str, str]:
        return {
            "Accept": "application/json",
            "Authorization": f"Bearer {self._token}",
            "User-Agent": "BaristaMatch-ERA/0.1",
        }

    @staticmethod
    def _query(service: str, limit: int) -> str:
        source = _LOG_SOURCES.get(service)
        if not source:
            raise ValueError("Supabase log service is not allowlisted")
        if not 1 <= limit <= 100:
            raise ValueError("Supabase result limit must be between 1 and 100")
        return "\n".join(
            (
                "select",
                "  timestamp as occurred_at,",
                "  log_attributes['response.status_code'] as status_code,",
                "  log_attributes['request.path'] as route,",
                "  count() as count",
                "from logs",
                f"where source_name = '{source}'",
                "  and (",
                "    toInt32OrZero(log_attributes['response.status_code']) >= 500",
                "    or lower(severity_text) in ('error', 'fatal')",
                "    or positionCaseInsensitive(event_message, 'error') > 0",
                "    or positionCaseInsensitive(event_message, 'fatal') > 0",
                "  )",
                "group by occurred_at, status_code, route",
                "order by occurred_at desc",
                f"limit {limit}",
            )
        )

    async def get_logs(
        self, project_ref: str, *, service: str, limit: int
    ) -> list[Mapping[str, Any]]:
        if not _PROJECT_REF.fullmatch(project_ref):
            raise ValueError("Supabase project reference is invalid")
        sql = self._query(service, limit)
        end = datetime.now(UTC).replace(microsecond=0)
        start = end - self._lookback
        query = urlencode(
            {
                "sql": sql,
                "iso_timestamp_start": start.isoformat().replace("+00:00", "Z"),
                "iso_timestamp_end": end.isoformat().replace("+00:00", "Z"),
            }
        )
        url = (
            "https://api.supabase.com/v1/projects/"
            f"{quote(project_ref)}/analytics/endpoints/logs?{query}"
        )
        payload = await self._transport.get_json(url, headers=self._headers())
        if not isinstance(payload, Mapping) or not isinstance(
            payload.get("result"), list
        ):
            raise ProviderReadError("Supabase returned an invalid log response")

        results: list[Mapping[str, Any]] = []
        for index, row in enumerate(_sequence(payload.get("result"))[:limit]):
            if not isinstance(row, Mapping):
                continue
            results.append(
                {
                    "id": f"supabase-{service}-{index}",
                    "occurred_at": row.get("occurred_at")
                    or end.isoformat().replace("+00:00", "Z"),
                    "level": "error",
                    "summary": f"Supabase {service} emitted an error",
                    "status_code": _status_code(row.get("status_code")),
                    "route": str(row.get("route"))[:300] if row.get("route") else None,
                    "count": int(row.get("count") or 1),
                }
            )
        return results
