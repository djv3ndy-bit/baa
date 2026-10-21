from __future__ import annotations

import asyncio
import time
import urllib.error
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime
from hashlib import sha256
from urllib.parse import urlsplit

from era.models import Environment, EvidenceSource, IncidentEvidence
from era.providers.health import HealthReadTransport, UrlLibHealthTransport


PUBLIC_OUTAGE_URLS = (
    "https://www.baristajobmatch.com/",
    "https://www.baristajobmatch.com/api/public-config",
)
PUBLIC_OUTAGE_INTERVAL_SECONDS = 15
PUBLIC_OUTAGE_SUMMARY = "Both public website endpoints failed three paired probes"


def _utc_now() -> datetime:
    return datetime.now(UTC)


def _failed_observation(status_code: object, unreachable: object) -> bool:
    return (
        type(status_code) is int and 500 <= status_code <= 599
    ) or (status_code is None and unreachable is True)


def is_confirmed_public_outage(evidence: IncidentEvidence) -> bool:
    """Require the composite's complete six-observation proof, not a bare flag."""
    metadata = evidence.metadata
    probes = metadata.get("public_outage_probes")
    if (
        evidence.source is not EvidenceSource.HEALTH
        or evidence.environment is not Environment.PRODUCTION
        or metadata.get("confirmed_public_outage") is not True
        or type(metadata.get("probe_interval_seconds")) is not int
        or metadata.get("probe_interval_seconds") != PUBLIC_OUTAGE_INTERVAL_SECONDS
        or not isinstance(probes, Sequence)
        or isinstance(probes, (str, bytes, bytearray))
        or len(probes) != 6
    ):
        return False
    if not all(
        isinstance(probe, Mapping)
        and type(probe.get("round")) is int
        and probe.get("round") in (1, 2, 3)
        and isinstance(probe.get("url"), str)
        and probe.get("url") in PUBLIC_OUTAGE_URLS
        for probe in probes
    ):
        return False
    for round_number in (1, 2, 3):
        paired = [
            probe for probe in probes
            if isinstance(probe, Mapping) and probe.get("round") == round_number
        ]
        if len(paired) != 2 or {probe.get("url") for probe in paired} != set(PUBLIC_OUTAGE_URLS):
            return False
        if not all(_failed_observation(probe.get("status_code"), probe.get("unreachable")) for probe in paired):
            return False
    return True


@dataclass(frozen=True, slots=True)
class HealthCollector:
    url: str
    allowed_hosts: frozenset[str]
    timeout_seconds: float = 8.0
    environment: Environment = Environment.PRODUCTION
    transport: HealthReadTransport = field(default_factory=UrlLibHealthTransport, repr=False)
    clock: Callable[[], datetime] = field(default=_utc_now, repr=False)

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
        status_code: int | None = None
        summary = "Health check failed"
        metadata: dict[str, object] = {"degraded": True}
        try:
            status_code = self.transport.get_status(self.url, timeout_seconds=self.timeout_seconds)
            if type(status_code) is not int or not 100 <= status_code <= 599:
                raise ValueError("Health transport returned an invalid HTTP status")
            healthy = 200 <= status_code < 300
            summary = "Health check passed" if healthy else "Health check returned a non-success status"
            metadata = {"degraded": not healthy}
        except urllib.error.HTTPError as error:
            status_code = error.code
            summary = "Health check returned an HTTP error"
            error.close()
        except OSError:
            metadata["availability"] = "down"
            summary = "Health check could not reach the endpoint"

        metadata["duration_ms"] = round((time.monotonic() - started) * 1_000)
        observed_at = self.clock()
        return IncidentEvidence(
            id=f"health-{int(observed_at.timestamp() * 1_000_000)}-{sha256(self.url.encode()).hexdigest()[:12]}",
            source=EvidenceSource.HEALTH,
            occurred_at=observed_at,
            summary=summary,
            environment=self.environment,
            route=urlsplit(self.url).path or "/",
            status_code=status_code,
            metadata=metadata,
        )

    async def collect(self) -> list[IncidentEvidence]:
        return [await asyncio.to_thread(self._collect_sync)]


@dataclass(frozen=True, slots=True)
class ConfirmedPublicOutageCollector:
    collectors: tuple[HealthCollector, HealthCollector]
    sleep: Callable[[float], Awaitable[None]] = field(default=asyncio.sleep, repr=False)
    clock: Callable[[], datetime] = field(default=_utc_now, repr=False)

    def __post_init__(self) -> None:
        if len(self.collectors) != 2 or {item.url for item in self.collectors} != set(PUBLIC_OUTAGE_URLS):
            raise ValueError("Outage confirmation is limited to the existing public website pair")
        if any(item.environment is not Environment.PRODUCTION for item in self.collectors):
            raise ValueError("Public outage confirmation requires production health checks")

    async def collect(self) -> list[IncidentEvidence]:
        evidence: list[IncidentEvidence] = []
        probes: list[dict[str, object]] = []
        for round_number in (1, 2, 3):
            if round_number > 1:
                await self.sleep(PUBLIC_OUTAGE_INTERVAL_SECONDS)
            results = await asyncio.gather(*(item.collect() for item in self.collectors))
            paired = []
            for collector, result in zip(self.collectors, results, strict=True):
                if len(result) != 1:
                    raise ValueError("Each public health probe must produce one observation")
                observation = result[0]
                paired.append(_failed_observation(
                    observation.status_code, observation.metadata.get("availability") == "down",
                ))
                evidence.append(replace(observation, metadata={
                    **observation.metadata, "public_probe_round": round_number,
                }))
                probes.append({
                    "round": round_number, "url": collector.url,
                    "status_code": observation.status_code,
                    "unreachable": observation.metadata.get("availability") == "down",
                })
            # Ordinary healthy/degraded cycles never make extra requests or wait.
            if round_number == 1 and not all(paired):
                return evidence

        confirmed_at = self.clock()
        confirmed = IncidentEvidence(
            id=f"confirmed-public-outage-{int(confirmed_at.timestamp() * 1_000_000)}",
            source=EvidenceSource.HEALTH,
            occurred_at=confirmed_at,
            summary=PUBLIC_OUTAGE_SUMMARY,
            environment=Environment.PRODUCTION,
            route="/",
            metadata={
                "degraded": True,
                "confirmed_public_outage": True,
                "probe_interval_seconds": PUBLIC_OUTAGE_INTERVAL_SECONDS,
                "public_outage_probes": probes,
            },
        )
        if is_confirmed_public_outage(confirmed):
            evidence.append(confirmed)
        return evidence
