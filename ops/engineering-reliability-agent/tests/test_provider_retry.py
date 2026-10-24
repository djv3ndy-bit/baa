import asyncio
import unittest
from unittest.mock import AsyncMock, patch

from era.providers.http import ProviderReadError, RetryOnceJsonTransport
from era.providers.supabase import SupabaseManagementSource


class ProviderRetryTests(unittest.IsolatedAsyncioTestCase):
    async def test_success_does_not_retry(self) -> None:
        source = AsyncMock()
        source.get_json.return_value = {"result": []}
        with patch("era.providers.http.asyncio.sleep", new_callable=AsyncMock) as delay:
            result = await RetryOnceJsonTransport(source).get_json(
                "https://api.supabase.com/example", headers={}
            )
        self.assertEqual(result, {"result": []})
        self.assertEqual(source.get_json.await_count, 1)
        delay.assert_not_awaited()

    async def test_retries_only_transient_get_failures_once(self) -> None:
        for status in (None, 502, 503, 504):
            with self.subTest(status=status):
                source = AsyncMock()
                source.get_json.side_effect = [
                    ProviderReadError("Unavailable", reason_code="timeout" if status is None else "http_error", http_status=status),
                    {"result": []},
                ]
                headers = {"Authorization": "Bearer private-test-token"}
                with patch("era.providers.http.asyncio.sleep", new_callable=AsyncMock) as delay:
                    result = await RetryOnceJsonTransport(source).get_json(
                        "https://api.supabase.com/example", headers=headers
                    )
                self.assertEqual(result, {"result": []})
                self.assertEqual(source.get_json.await_count, 2)
                self.assertEqual(source.get_json.await_args_list[0], source.get_json.await_args_list[1])
                delay.assert_awaited_once_with(1)

    async def test_exhaustion_preserves_failure_not_empty_results(self) -> None:
        source = AsyncMock()
        final = ProviderReadError("Provider GET failed with HTTP 503", reason_code="http_error", http_status=503)
        source.get_json.side_effect = [ProviderReadError("Timed out", reason_code="timeout"), final]
        with patch("era.providers.http.asyncio.sleep", new_callable=AsyncMock):
            with self.assertRaises(ProviderReadError) as raised:
                await RetryOnceJsonTransport(source).get_json("https://api.supabase.com/example", headers={})
        self.assertIs(raised.exception, final)
        self.assertEqual(raised.exception.diagnostics(), {"reason_code": "http_error", "http_status": 503})
        self.assertEqual(source.get_json.await_count, 2)

    async def test_auth_rate_limit_redirect_and_invalid_data_are_not_retried(self) -> None:
        errors = [ProviderReadError("Failed", reason_code="http_error", http_status=status)
                  for status in (301, 401, 403, 429, 500)]
        errors.extend(ProviderReadError("Failed", reason_code=reason) for reason in (
            "invalid_request", "invalid_json", "invalid_response", "response_too_large", "transport_error"
        ))
        errors.extend((asyncio.CancelledError(), RuntimeError("Unexpected failure")))
        for error in errors:
            with self.subTest(error=type(error), reason=getattr(error, "reason_code", None), status=getattr(error, "http_status", None)):
                source = AsyncMock()
                source.get_json.side_effect = error
                with patch("era.providers.http.asyncio.sleep", new_callable=AsyncMock) as delay:
                    with self.assertRaises(type(error)):
                        await RetryOnceJsonTransport(source).get_json("https://api.supabase.com/example", headers={})
                self.assertEqual(source.get_json.await_count, 1)
                delay.assert_not_awaited()

    async def test_default_supabase_source_retries_without_changing_query(self) -> None:
        source = SupabaseManagementSource("private-test-token")
        with patch("era.providers.http.UrlLibJsonTransport._get_sync", side_effect=[
            ProviderReadError("Timed out", reason_code="timeout"), {"result": []}
        ]) as read, patch("era.providers.http.asyncio.sleep", new_callable=AsyncMock):
            result = await source.get_logs("project123", service="api", limit=5)
        self.assertEqual(result, [])
        self.assertEqual(read.call_count, 2)
        self.assertEqual(read.call_args_list[0], read.call_args_list[1])


if __name__ == "__main__":
    unittest.main()
