from __future__ import annotations

import asyncio
import json
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any, Mapping, Protocol
from urllib.parse import urlsplit


class ProviderReadError(RuntimeError):
    """A provider read failed without exposing its response body or credentials."""


class JsonGetTransport(Protocol):
    async def get_json(self, url: str, *, headers: Mapping[str, str]) -> Any: ...


class _NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001, ANN201
        return None


@dataclass(frozen=True, slots=True)
class UrlLibJsonTransport:
    """Small HTTPS transport whose only operation is a bounded GET."""

    allowed_hosts: frozenset[str]
    timeout_seconds: float = 8.0
    max_response_bytes: int = 1_000_000

    def __post_init__(self) -> None:
        if not self.allowed_hosts:
            raise ValueError("At least one provider host must be allowlisted")
        if not 0 < self.timeout_seconds <= 10:
            raise ValueError("Provider timeout must be between 0 and 10 seconds")
        if not 1_024 <= self.max_response_bytes <= 2_000_000:
            raise ValueError("Provider response limit is outside the safe range")

    def _get_sync(self, url: str, headers: Mapping[str, str]) -> Any:
        parsed = urlsplit(url)
        if parsed.scheme != "https":
            raise ProviderReadError("Provider requests require HTTPS")
        if not parsed.hostname or parsed.hostname.lower() not in self.allowed_hosts:
            raise ProviderReadError("Provider host is not allowlisted")
        if parsed.username or parsed.password or parsed.fragment:
            raise ProviderReadError("Provider URL contains forbidden components")

        request = urllib.request.Request(
            url,
            method="GET",
            headers=dict(headers),
        )
        opener = urllib.request.build_opener(_NoRedirectHandler())
        try:
            with opener.open(request, timeout=self.timeout_seconds) as response:
                body = response.read(self.max_response_bytes + 1)
        except urllib.error.HTTPError as error:
            raise ProviderReadError(
                f"Provider GET failed with HTTP {error.code}"
            ) from None
        except (urllib.error.URLError, TimeoutError, OSError):
            raise ProviderReadError("Provider GET could not be completed") from None

        if len(body) > self.max_response_bytes:
            raise ProviderReadError("Provider response exceeded the safe size limit")
        try:
            return json.loads(body)
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise ProviderReadError("Provider returned invalid JSON") from None

    async def get_json(self, url: str, *, headers: Mapping[str, str]) -> Any:
        return await asyncio.to_thread(self._get_sync, url, headers)
