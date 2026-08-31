import json
import unittest
import urllib.error
from io import BytesIO
from unittest.mock import patch

from era.providers.http import ProviderReadError, UrlLibJsonTransport


class FakeResponse:
    def __init__(self, body: bytes) -> None:
        self._body = BytesIO(body)

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        return False

    def read(self, size: int) -> bytes:
        return self._body.read(size)


class FakeOpener:
    def __init__(self, response) -> None:
        self.response = response
        self.requests = []

    def open(self, request, timeout):
        self.requests.append((request, timeout))
        if isinstance(self.response, Exception):
            raise self.response
        return self.response


class ProviderTransportTests(unittest.IsolatedAsyncioTestCase):
    async def test_transport_only_sends_get_to_allowlisted_https_host(self) -> None:
        opener = FakeOpener(FakeResponse(json.dumps({"ok": True}).encode()))
        transport = UrlLibJsonTransport(frozenset({"api.example.com"}))

        with patch("urllib.request.build_opener", return_value=opener):
            payload = await transport.get_json(
                "https://api.example.com/status", headers={"Accept": "application/json"}
            )

        self.assertEqual(payload, {"ok": True})
        self.assertEqual(opener.requests[0][0].get_method(), "GET")

    async def test_transport_rejects_untrusted_hosts_and_redirects(self) -> None:
        transport = UrlLibJsonTransport(frozenset({"api.example.com"}))
        with self.assertRaises(ProviderReadError):
            await transport.get_json("https://attacker.example/status", headers={})

        redirect = urllib.error.HTTPError(
            "https://api.example.com/status", 302, "Found", {}, None
        )
        with patch("urllib.request.build_opener", return_value=FakeOpener(redirect)):
            with self.assertRaisesRegex(ProviderReadError, "HTTP 302"):
                await transport.get_json("https://api.example.com/status", headers={})

    async def test_transport_does_not_include_error_bodies(self) -> None:
        error = urllib.error.HTTPError(
            "https://api.example.com/status",
            403,
            "secret-token-in-reason",
            {},
            BytesIO(b"sensitive response body"),
        )
        transport = UrlLibJsonTransport(frozenset({"api.example.com"}))
        with patch("urllib.request.build_opener", return_value=FakeOpener(error)):
            with self.assertRaises(ProviderReadError) as raised:
                await transport.get_json("https://api.example.com/status", headers={})

        self.assertEqual(str(raised.exception), "Provider GET failed with HTTP 403")
        self.assertNotIn("sensitive", str(raised.exception))

    async def test_transport_reads_bounded_stream_json(self) -> None:
        opener = FakeOpener(FakeResponse(b'{"statusCode":500}\n{"statusCode":502}\n'))
        transport = UrlLibJsonTransport(frozenset({"api.example.com"}))

        with patch("urllib.request.build_opener", return_value=opener):
            payload = await transport.get_json(
                "https://api.example.com/events", headers={}
            )

        self.assertEqual(payload, [{"statusCode": 500}, {"statusCode": 502}])


if __name__ == "__main__":
    unittest.main()
