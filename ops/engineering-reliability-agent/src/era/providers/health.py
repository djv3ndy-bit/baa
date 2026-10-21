from __future__ import annotations

import urllib.request
from typing import Protocol


class HealthReadTransport(Protocol):
    def get_status(self, url: str, *, timeout_seconds: float) -> int: ...


class _NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001, ANN201
        return None


class UrlLibHealthTransport:
    """One bounded, credential-free GET; discard bodies and refuse redirects."""

    def get_status(self, url: str, *, timeout_seconds: float) -> int:
        request = urllib.request.Request(
            url,
            method="GET",
            headers={"User-Agent": "BaristaMatch-ERA/0.1"},
        )
        opener = urllib.request.build_opener(_NoRedirectHandler())
        with opener.open(request, timeout=timeout_seconds) as response:
            response.read(512)
            return response.status
