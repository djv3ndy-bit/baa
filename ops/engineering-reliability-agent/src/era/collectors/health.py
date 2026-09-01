from __future__ import annotations

import asyncio
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import UTC, datetime
from urllib.parse import urlsplit

from era.models import Environment, EvidenceSource, IncidentEvidence


class _NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001, ANN201
        return None


@dataclass(frozen=True, slots=True)
class HealthCollector:
    url: str
    allowed_hosts: frozenset[str]
    timeout_seconds: float = 8.0
    environment: Environment = Environment.PRODUCTION

    def __post_init__(self) -> None:
        parsed = urlsplit(self.url)
        if parsed.scheme != "https":
            raise ValueError("Health checks require HTTPS")
        if not parsed.hostname or parsed.hostname.lower() not in self.allowed_hosts:
            raise ValueError("Health-check host is not allowlisted")
        if parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError(
                "Health-check URLs may not contain credentials, queries, or fragments"
            )
        if not 0 < self.timeout_seconds <= 10:
            raise ValueError("Health-check timeout must be between 0 and 10 seconds")

    def _collect_sync(self) -> IncidentEvidence:
        started = time.monotonic()
        request = urllib.request.Request(
            self.url,
            method="GET",
            headers={"User-Agent": "BaristaMatch-ERA/0.1"},
        )
        opener = urllib.request.build_opener(_NoRedirectHandler())
        status_code: int | None = None
        summary = "Health check failed"
        metadata: dict[str, object] = {"degraded": True}
        try:
            with opener.open(request, timeout=self.timeout_seconds) as response:
                status_code = response.status
                response.read(512)
                healthy = 200 <= status_code < 300
                summary = (
                    "Health check passed"
                    if healthy
                    else "Health check returned a non-success status"
                )
                metadata = {"degraded": not healthy}
        except urllib.error.HTTPError as error:
            status_code = error.code
            summary = "Health check returned an HTTP error"
        except (urllib.error.URLError, TimeoutError):
            metadata["availability"] = "down"
            summary = "Health check could not reach the endpoint"

        metadata["duration_ms"] = round((time.monotonic() - started) * 1_000)
        return IncidentEvidence(
            id=f"health-{int(datetime.now(UTC).timestamp() * 1000)}",
            source=EvidenceSource.HEALTH,
            occurred_at=datetime.now(UTC),
            summary=summary,
            environment=self.environment,
            route=urlsplit(self.url).path or "/",
            status_code=status_code,
            metadata=metadata,
        )

    async def collect(self) -> list[IncidentEvidence]:
        return [await asyncio.to_thread(self._collect_sync)]
