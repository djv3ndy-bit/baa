"""Counts-only read contract for the separately authorized production runtime feed."""
from __future__ import annotations

import asyncio
import base64
import http.client
import json
import re
import ssl
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Callable
from urllib.parse import parse_qs, urlencode, urlsplit

from .http import JsonGetTransport, ProviderReadError

RUNTIME_SUMMARY_URL = "https://lmwqrxoitraofaftpwhe.supabase.co/functions/v1/era-runtime"
RUNTIME_PROJECT = "prj_VuAxQpdhDJPeTPdanA5HjtOrylA5"
CATEGORIES = frozenset({"runtime_error", "runtime_fatal", "http_5xx", "runtime_ok"})
_FIELDS = {"schema_version", "project_id", "environment", "window", "counts",
           "coverage_started_at", "last_delivery_at", "complete", "truncated"}
_UTC = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)")


def _fail(reason: str = "runtime_summary_invalid_response") -> ProviderReadError:
    return ProviderReadError("Runtime summary coverage could not be verified", reason_code=reason)


def _utc(value: object) -> datetime:
    if type(value) is not str or not _UTC.fullmatch(value):
        raise _fail()
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        raise _fail() from None


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class RuntimeSummaryHttpTransport:
    """No proxy, redirect, key logging, arbitrary endpoint or non-GET operation."""
    def _get_sync(self, url, headers):
        parsed = urlsplit(url)
        try:
            query = parse_qs(parsed.query, strict_parsing=True, keep_blank_values=True)
            valid = (parsed.scheme == "https" and parsed.netloc == "lmwqrxoitraofaftpwhe.supabase.co"
                     and parsed.path == "/functions/v1/era-runtime" and not parsed.fragment
                     and set(query) == {"since", "until"} and all(len(v) == 1 for v in query.values()))
        except ValueError:
            valid = False
        if not valid:
            raise _fail("invalid_request")
        start, end = _utc(query["since"][0]), _utc(query["until"][0])
        if not timedelta(0) < end - start <= timedelta(hours=2):
            raise _fail("invalid_request")
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        context.check_hostname = True
        context.verify_mode = ssl.CERT_REQUIRED
        context.load_default_certs()
        context.keylog_filename = None
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect(),
                                            urllib.request.HTTPSHandler(context=context))
        request = urllib.request.Request(url, method="GET", headers=dict(headers))
        try:
            with opener.open(request, timeout=8) as response:
                if type(response.status) is not int or response.status != 200:
                    raise _fail()
                body = response.read(16_385)
        except urllib.error.HTTPError as error:
            status = error.code
            error.close()
            raise ProviderReadError("Runtime summary GET failed", reason_code="http_error", http_status=status) from None
        except TimeoutError:
            raise _fail("timeout") from None
        except urllib.error.URLError as error:
            raise _fail("timeout" if isinstance(error.reason, TimeoutError) else "transport_error") from None
        except (OSError, http.client.HTTPException):
            raise _fail("transport_error") from None
        if len(body) > 16_384:
            raise _fail("response_too_large")
        try:
            return json.loads(body)
        except (ValueError, RecursionError):
            raise _fail("invalid_json") from None

    async def get_json(self, url, *, headers):
        return await asyncio.to_thread(self._get_sync, url, headers)


@dataclass(frozen=True)
class RuntimeSummary:
    until: datetime
    counts: dict[str, int]


class RuntimeSummarySource:
    def __init__(self, token: str = "", *, identity: Callable[[], str] | None = None,
                 transport: JsonGetTransport | None = None,
                 clock: Callable[[], datetime] = lambda: datetime.now(UTC)):
        self._token, self._transport, self._clock = token, transport or RuntimeSummaryHttpTransport(), clock
        self._identity = identity

    async def read(self, project_id: str, environment: str, since: str) -> RuntimeSummary:
        if project_id != RUNTIME_PROJECT or environment != "production":
            raise _fail("runtime_summary_configuration_failed")
        match = re.fullmatch(r"([1-9][0-9]{0,2})([mh])", since)
        if not match:
            raise _fail("invalid_request")
        minutes = int(match[1]) * (60 if match[2] == "h" else 1)
        if minutes > 120:
            raise _fail("invalid_request")
        instant = self._clock()
        if instant.tzinfo is None or instant.utcoffset() is None:
            raise _fail("runtime_summary_configuration_failed")
        end = instant.astimezone(UTC).replace(microsecond=0)
        # Acquire at collection time, so unavailable GitHub identity permissions
        # cannot discard independently successful deployment reads.
        token = await asyncio.to_thread(self._identity) if self._identity else self._token
        if (type(token) is not str
                or not 32 <= len(token) <= 16384
                or re.fullmatch(r"[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+", token) is None):
            raise _fail("runtime_summary_configuration_failed")
        # These routing checks prevent accidental use of unrelated credentials.
        # The Edge receiver must independently verify the RS256 signature/JWKS.
        try:
            header, claims = [json.loads(base64.urlsafe_b64decode(part + "=" * (-len(part) % 4)))
                              for part in token.split(".")[:2]]
            if (type(header) is not dict or header.get("alg") != "RS256"
                    or type(claims) is not dict
                    or claims.get("iss") != "https://token.actions.githubusercontent.com"
                    or claims.get("aud") != RUNTIME_SUMMARY_URL
                    or claims.get("sub") != "repo:djv3ndy-bit@313253306/baa@1324630119:ref:refs/heads/main"
                    or claims.get("repository_id") != "1324630119"
                    or claims.get("repository_owner_id") != "313253306"
                    or claims.get("workflow_ref") != "djv3ndy-bit/baa/.github/workflows/engineering-reliability-monitor.yml@refs/heads/main"
                    or any(type(claims.get(k)) is not int for k in ("iat", "nbf", "exp"))
                    or not 0 < claims["exp"] - claims["iat"] <= 600
                    or claims["iat"] > end.timestamp() + 60
                    or claims["nbf"] > end.timestamp() + 60 or claims["exp"] <= end.timestamp()):
                raise ValueError
        except (ValueError, RecursionError):
            raise _fail("runtime_summary_configuration_failed") from None
        start = end - timedelta(minutes=minutes)
        query = urlencode({"since": start.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
                           "until": end.isoformat(timespec="milliseconds").replace("+00:00", "Z")})
        payload = await self._transport.get_json(RUNTIME_SUMMARY_URL + "?" + query, headers={
            "Authorization": "Bearer " + token, "Accept": "application/json",
            "User-Agent": "BaristaMatch-runtime-summary/1.0",
        })
        if (type(payload) is not dict or set(payload) != _FIELDS
                or type(payload["schema_version"]) is not int or payload["schema_version"] != 1
                or payload["project_id"] != RUNTIME_PROJECT or payload["environment"] != "production"
                or type(payload["complete"]) is not bool or type(payload["truncated"]) is not bool
                or type(payload["window"]) is not dict or set(payload["window"]) != {"since", "until"}
                or type(payload["counts"]) is not dict or set(payload["counts"]) != CATEGORIES):
            raise _fail()
        if (_utc(payload["window"]["since"]) != start or _utc(payload["window"]["until"]) != end
                or any(type(n) is not int or not 0 <= n <= 2_147_483_647 for n in payload["counts"].values())):
            raise _fail()
        if payload["coverage_started_at"] is None or payload["last_delivery_at"] is None:
            raise _fail("runtime_summary_warming_up")
        coverage, delivery = _utc(payload["coverage_started_at"]), _utc(payload["last_delivery_at"])
        if coverage > delivery or delivery > end + timedelta(seconds=60):
            raise _fail()
        if coverage > start:
            raise _fail("runtime_summary_warming_up")
        if delivery < end - timedelta(minutes=15):
            raise _fail("runtime_summary_stale")
        if not payload["complete"] or payload["truncated"]:
            raise _fail("runtime_summary_partial")
        return RuntimeSummary(end, dict(payload["counts"]))
