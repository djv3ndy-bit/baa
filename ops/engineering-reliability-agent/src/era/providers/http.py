from __future__ import annotations

import asyncio
import json
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any, Mapping, Protocol
from urllib.parse import urlsplit


_FAILURE_REASONS = frozenset({
    "provider_read_failed", "http_error", "timeout", "transport_error",
    "invalid_request", "invalid_json", "invalid_response", "response_too_large",
})


def safe_failure_diagnostics(reason_code: object, http_status: object = None) -> dict[str, Any]:
    """Only fixed categories and an integer HTTP status may leave the transport."""
    if type(reason_code) is not str or reason_code not in _FAILURE_REASONS:
        return {}
    result: dict[str, Any] = {"reason_code": reason_code}
    if reason_code == "http_error" and type(http_status) is int and 300 <= http_status <= 599:
        result["http_status"] = http_status
    return result


class ProviderReadError(RuntimeError):
    """A provider read failed without exposing its response body or credentials."""

    def __init__(self, message: str, *, reason_code: str = "provider_read_failed",
                 http_status: int | None = None) -> None:
        super().__init__(message)
        diagnostic = safe_failure_diagnostics(reason_code, http_status)
        self.reason_code = diagnostic.get("reason_code", "provider_read_failed")
        self.http_status = diagnostic.get("http_status")

    def diagnostics(self) -> dict[str, Any]:
        return safe_failure_diagnostics(self.reason_code, self.http_status)


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
            raise ProviderReadError("Provider requests require HTTPS", reason_code="invalid_request")
        if not parsed.hostname or parsed.hostname.lower() not in self.allowed_hosts:
            raise ProviderReadError("Provider host is not allowlisted", reason_code="invalid_request")
        if parsed.username or parsed.password or parsed.fragment:
            raise ProviderReadError("Provider URL contains forbidden components", reason_code="invalid_request")

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
                f"Provider GET failed with HTTP {error.code}",
                reason_code="http_error", http_status=error.code,
            ) from None
        except TimeoutError:
            raise ProviderReadError("Provider GET could not be completed", reason_code="timeout") from None
        except urllib.error.URLError as error:
            reason = "timeout" if isinstance(error.reason, TimeoutError) else "transport_error"
            raise ProviderReadError("Provider GET could not be completed", reason_code=reason) from None
        except OSError:
            raise ProviderReadError("Provider GET could not be completed", reason_code="transport_error") from None

        if len(body) > self.max_response_bytes:
            raise ProviderReadError("Provider response exceeded the safe size limit", reason_code="response_too_large")
        try:
            return json.loads(body)
        except (UnicodeDecodeError, json.JSONDecodeError):
            pass

        try:
            lines = [line for line in body.splitlines() if line.strip()]
            if not lines:
                raise ValueError
            return [json.loads(line) for line in lines]
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError):
            raise ProviderReadError("Provider returned invalid JSON", reason_code="invalid_json") from None

    async def get_json(self, url: str, *, headers: Mapping[str, str]) -> Any:
        return await asyncio.to_thread(self._get_sync, url, headers)
