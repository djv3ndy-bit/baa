from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class AgentConfig:
    model: str | None
    environment: str
    allowed_health_hosts: frozenset[str]

    @classmethod
    def from_environment(cls) -> "AgentConfig":
        hosts = {
            host.strip().lower()
            for host in os.getenv("ERA_ALLOWED_HEALTH_HOSTS", "").split(",")
            if host.strip()
        }
        return cls(
            model=os.getenv("ERA_MODEL") or None,
            environment=os.getenv("ERA_ENVIRONMENT", "development"),
            allowed_health_hosts=frozenset(hosts),
        )

    def require_openai(self) -> None:
        if not os.getenv("OPENAI_API_KEY"):
            raise RuntimeError("OPENAI_API_KEY is required for live analysis")
