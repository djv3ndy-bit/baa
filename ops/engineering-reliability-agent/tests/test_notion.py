import unittest

from era.notion import sync_response_package


def response_package(*, incident=True, severity="P1"):
    return {
        "incident": incident,
        "severity": severity,
        "fingerprint": "0123456789abcdef",
        "title": "Production authentication failure",
        "summary": "Sign-in checks failed for a sanitized synthetic account.",
        "likely_cause": "A recent authentication change may be related.",
        "recommended_actions": [
            "Review the sanitized evidence.",
            "Reproduce in preview.",
        ],
        "repair": {"owner_approval_required": True},
    }


class FakeNotion:
    def __init__(self, existing=None):
        self.calls = []
        self.existing = existing

    def __call__(self, method, url, token, payload):
        self.calls.append((method, url, token, payload))
        if url.endswith("/query"):
            return {"results": [self.existing] if self.existing else []}
        if method == "PATCH":
            return {"id": "existing-page", "url": "https://notion.so/existing"}
        return {"id": "new-page", "url": "https://notion.so/new"}


class NotionSyncTests(unittest.TestCase):
    def test_healthy_result_is_not_written(self):
        transport = FakeNotion()
        result = sync_response_package(
            response_package(incident=False, severity="P3"),
            token="secret-token",
            data_source_id="64a712d1-8a77-44da-8db5-6a80b9ace054",
            source_url="https://github.com/djv3ndy-bit/baa/actions/runs/1",
            request_json=transport,
        )

        self.assertEqual(result["status"], "skipped_healthy")
        self.assertEqual(transport.calls, [])

    def test_missing_token_fails_closed_without_network(self):
        transport = FakeNotion()
        result = sync_response_package(
            response_package(),
            token="",
            data_source_id="64a712d1-8a77-44da-8db5-6a80b9ace054",
            source_url="https://github.com/djv3ndy-bit/baa/actions/runs/1",
            request_json=transport,
        )

        self.assertEqual(result["status"], "configuration_required")
        self.assertFalse(result["attempted"])
        self.assertEqual(transport.calls, [])

    def test_incident_creates_owner_approval_task(self):
        transport = FakeNotion()
        result = sync_response_package(
            response_package(),
            token="secret-token",
            data_source_id="collection://64a712d1-8a77-44da-8db5-6a80b9ace054",
            source_url="https://github.com/djv3ndy-bit/baa/actions/runs/123",
            request_json=transport,
        )

        self.assertEqual(result["status"], "created")
        self.assertEqual(len(transport.calls), 2)
        query = transport.calls[0]
        self.assertEqual(query[0], "POST")
        self.assertTrue(query[1].endswith("/data_sources/64a712d1-8a77-44da-8db5-6a80b9ace054/query"))
        create = transport.calls[1]
        properties = create[3]["properties"]
        self.assertEqual(properties["Status"]["select"]["name"], "Waiting for Owner Approval")
        self.assertEqual(properties["Priority"]["select"]["name"], "High")
        self.assertTrue(properties["Owner Approval Required"]["checkbox"])
        self.assertEqual(properties["Source"]["select"]["name"], "GitHub Actions")
        self.assertNotIn("secret-token", str(create[3]))

    def test_same_fingerprint_updates_existing_task(self):
        transport = FakeNotion(existing={"id": "existing-page"})
        result = sync_response_package(
            response_package(severity="P2"),
            token="secret-token",
            data_source_id="64a712d1-8a77-44da-8db5-6a80b9ace054",
            source_url="https://github.com/djv3ndy-bit/baa/actions/runs/456",
            request_json=transport,
        )

        self.assertEqual(result["status"], "updated")
        self.assertEqual(len(transport.calls), 2)
        self.assertEqual(transport.calls[1][0], "PATCH")
        self.assertTrue(transport.calls[1][1].endswith("/pages/existing-page"))
        priority = transport.calls[1][3]["properties"]["Priority"]["select"]["name"]
        self.assertEqual(priority, "Medium")


if __name__ == "__main__":
    unittest.main()
