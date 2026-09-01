from __future__ import annotations

import asyncio
import re
from dataclasses import asdict, dataclass
from typing import Any, Awaitable, Callable, Mapping, Protocol

from .redaction import sanitize_identifier


_COMMIT_SHA = re.compile(r"[0-9a-fA-F]{7,64}")


class DeploymentStateSource(Protocol):
    async def get_deployment_state_for_commit(
        self,
        project_id: str,
        *,
        environment: str,
        commit_sha: str,
        limit: int = 25,
    ) -> Mapping[str, Any]: ...


@dataclass(frozen=True, slots=True)
class DeploymentVerificationResult:
    status: str
    severity: str
    state: str
    commit_sha: str
    deployment_id: str
    attempts: int
    error_type: str | None = None

    @property
    def exit_code(self) -> int:
        return 0 if self.status == "ready" else 2

    def to_dict(self) -> dict[str, Any]:
        value = asdict(self)
        value.update(
            {
                "mode": "post_merge_verification",
                "provider": "vercel",
                "operation": "exact_production_revision",
                "alert_required": self.exit_code != 0,
                "exit_code": self.exit_code,
                "model_used": False,
                "production_writes_enabled": False,
            }
        )
        return value


async def wait_for_production_revision(
    source: DeploymentStateSource,
    project_id: str,
    commit_sha: str,
    *,
    attempts: int = 60,
    delay_seconds: float = 10,
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
) -> DeploymentVerificationResult:
    if not _COMMIT_SHA.fullmatch(commit_sha):
        raise ValueError("Production verification requires a commit SHA")
    if not 1 <= attempts <= 72:
        raise ValueError("Deployment verification attempts must be between 1 and 72")
    if not 0 <= delay_seconds <= 30:
        raise ValueError("Deployment verification delay must be between 0 and 30 seconds")

    last_state = "NOT_FOUND"
    last_deployment_id = "unknown"
    for attempt in range(1, attempts + 1):
        snapshot = await source.get_deployment_state_for_commit(
            project_id,
            environment="production",
            commit_sha=commit_sha,
            limit=25,
        )
        last_state = sanitize_identifier(
            str(snapshot.get("state", "UNKNOWN")), max_length=40
        ).upper()
        last_deployment_id = sanitize_identifier(
            str(snapshot.get("deployment_id", "unknown")), max_length=160
        )
        if last_state == "READY":
            return DeploymentVerificationResult(
                "ready",
                "P3",
                last_state,
                commit_sha.lower(),
                last_deployment_id,
                attempt,
            )
        if last_state in {"ERROR", "CANCELED", "CANCELLED"}:
            return DeploymentVerificationResult(
                "deployment_failed",
                "P2",
                last_state,
                commit_sha.lower(),
                last_deployment_id,
                attempt,
                error_type="VercelDeploymentFailed",
            )
        if attempt < attempts:
            await sleep(delay_seconds)

    return DeploymentVerificationResult(
        "deployment_timeout",
        "P2",
        last_state,
        commit_sha.lower(),
        last_deployment_id,
        attempts,
        error_type="VercelDeploymentTimeout",
    )
