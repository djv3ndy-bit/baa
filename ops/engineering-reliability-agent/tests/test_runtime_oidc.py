import unittest
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

from era.providers.http import ProviderReadError
from era.runtime_oidc import RUNTIME_AUDIENCE, acquire_github_runtime_identity


TOKEN = ".".join(["a" * 20, "b" * 20, "c" * 32])
ENV = {
    "ACTIONS_ID_TOKEN_REQUEST_URL": "https://run-actions.example.actions.githubusercontent.com/idtoken?job=123&audience=old",
    "ACTIONS_ID_TOKEN_REQUEST_TOKEN": "synthetic-request-credential",
}


class Response:
    status = 200

    def __init__(self, body):
        self.body = body

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def read(self, size):
        return self.body[:size]


class Opener:
    def __init__(self, body):
        self.body = body
        self.requests = []

    def open(self, request, timeout):
        self.requests.append((request, timeout))
        return Response(self.body)


class RuntimeOidcTests(unittest.TestCase):
    def test_fixed_audience_and_in_memory_token(self):
        opener = Opener(('{"value":"' + TOKEN + '"}').encode())
        with patch("era.runtime_oidc.urllib.request.build_opener", return_value=opener):
            self.assertEqual(acquire_github_runtime_identity(ENV), TOKEN)
        request, timeout = opener.requests[0]
        self.assertEqual(request.get_method(), "GET")
        self.assertEqual(timeout, 8)
        self.assertEqual(parse_qs(urlsplit(request.full_url).query)["audience"], [RUNTIME_AUDIENCE])
        self.assertEqual(request.get_header("Authorization"), "Bearer synthetic-request-credential")

    def test_untrusted_destinations_and_missing_permission_fail_before_network(self):
        for target in ("http://run.actions.githubusercontent.com/idtoken", "https://evil.example/idtoken",
                       "https://run.actions.githubusercontent.com.evil.example/idtoken",
                       "https://user@run.actions.githubusercontent.com/idtoken",
                       "https://run.actions.githubusercontent.com:444/idtoken",
                       "https://run.actions.githubusercontent.com/idtoken#fragment", ""):
            with self.subTest(target=target), patch("era.runtime_oidc.urllib.request.build_opener") as build:
                with self.assertRaises(ProviderReadError):
                    acquire_github_runtime_identity({**ENV, "ACTIONS_ID_TOKEN_REQUEST_URL": target})
                build.assert_not_called()
        with self.assertRaises(ProviderReadError):
            acquire_github_runtime_identity({})

    def test_invalid_or_oversized_response_never_leaks_body(self):
        bodies = [b"<html>secret-marker</html>", b'{"value":"secret-marker"}',
                  b'{"value":' + b"1" * 5000 + b"}", b" " * 32769]
        for body in bodies:
            with self.subTest(size=len(body)), patch("era.runtime_oidc.urllib.request.build_opener", return_value=Opener(body)):
                with self.assertRaises(ProviderReadError) as raised:
                    acquire_github_runtime_identity(ENV)
                self.assertNotIn("secret-marker", str(raised.exception))
                self.assertNotIn(ENV["ACTIONS_ID_TOKEN_REQUEST_TOKEN"], str(raised.exception))


if __name__ == "__main__":
    unittest.main()
