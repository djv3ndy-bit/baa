import json
import unittest
from unittest.mock import patch

from era.main import _HealthHandler


class ReadinessLoggingTests(unittest.TestCase):
    def test_readiness_log_drops_query_strings_and_request_lines(self) -> None:
        handler = _HealthHandler.__new__(_HealthHandler)
        handler.path = "/health?token=must-not-leak"

        with patch("builtins.print") as output:
            handler.log_message(
                '"%s" %s %s',
                "GET /health?token=must-not-leak HTTP/1.1",
                "200",
                "-",
            )

        payload = json.loads(output.call_args.args[0])
        self.assertEqual(payload["path"], "/health")
        self.assertNotIn("must-not-leak", str(payload))


if __name__ == "__main__":
    unittest.main()
