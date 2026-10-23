"""Obtain a short-lived GitHub identity for the fixed runtime count reader."""
from __future__ import annotations

import json
import http.client
import re
import ssl
import urllib.error
import urllib.request
from collections.abc import Mapping
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from .providers.http import ProviderReadError


RUNTIME_AUDIENCE = "https://lmwqrxoitraofaftpwhe.supabase.co/functions/v1/era-runtime"
_JWT = re.compile(r"[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}")


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def acquire_github_runtime_identity(environment: Mapping[str, str]) -> str:
    """Keep the runner request credential and returned JWT inside this process.

    The receiver independently verifies the signature, audience, immutable repo
    and owner IDs, protected main ref and the exact monitoring workflow path.
    """
    raw_url = environment.get("ACTIONS_ID_TOKEN_REQUEST_URL", "")
    request_token = environment.get("ACTIONS_ID_TOKEN_REQUEST_TOKEN", "")
    try:
        if (not 1 <= len(raw_url) <= 4096
                or any(not 33 <= ord(c) <= 126 for c in raw_url)
                or not 16 <= len(request_token) <= 16384
                or any(not 33 <= ord(c) <= 126 for c in request_token)):
            raise ValueError
        url = urlsplit(raw_url)
        host = (url.hostname or "").lower()
        if (url.scheme != "https" or not host.endswith(".actions.githubusercontent.com")
                or url.port not in (None, 443) or url.username or url.password
                or url.fragment or not url.path.startswith("/")):
            raise ValueError
        query = [(key, value) for key, value in parse_qsl(
            url.query, keep_blank_values=True, max_num_fields=64,
        ) if key != "audience"]
        query.append(("audience", RUNTIME_AUDIENCE))
        target = urlunsplit(("https", url.netloc, url.path, urlencode(query), ""))
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        context.check_hostname = True
        context.verify_mode = ssl.CERT_REQUIRED
        context.load_default_certs()
        context.keylog_filename = None
        opener = urllib.request.build_opener(
            urllib.request.ProxyHandler({}), _NoRedirect(),
            urllib.request.HTTPSHandler(context=context),
        )
        request = urllib.request.Request(target, method="GET", headers={
            "Authorization": "Bearer " + request_token,
            "Accept": "application/json",
        })
        with opener.open(request, timeout=8) as response:
            if response.status != 200:
                raise ValueError
            body = response.read(32769)
        if len(body) > 32768:
            raise ValueError
        payload = json.loads(body)
        token = payload.get("value") if isinstance(payload, dict) else None
        if (type(token) is not str or len(token) > 16384
                or _JWT.fullmatch(token) is None):
            raise ValueError
        return token
    except urllib.error.HTTPError as error:
        error.close()
    except (ValueError, UnicodeError, OSError, urllib.error.URLError,
            http.client.HTTPException, RecursionError):
        pass
    raise ProviderReadError(
        "The GitHub runtime identity could not be obtained",
        reason_code="runtime_identity_unavailable",
    ) from None
