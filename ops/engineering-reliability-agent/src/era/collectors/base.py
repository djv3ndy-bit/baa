from __future__ import annotations

from collections.abc import Sequence
from typing import Protocol

from era.models import IncidentEvidence


class ReadOnlyCollector(Protocol):
    async def collect(self) -> Sequence[IncidentEvidence]: ...
