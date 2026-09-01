import unittest

from era.verification import wait_for_production_revision


class SequenceSource:
    def __init__(self, states):
        self.states = list(states)
        self.calls = 0

    async def get_deployment_state_for_commit(
        self, project_id, *, environment, commit_sha, limit=25
    ):
        self.calls += 1
        state = self.states.pop(0)
        return {
            "state": state,
            "deployment_id": "dpl_synthetic",
            "commit_sha": commit_sha,
        }


class DeploymentVerificationTests(unittest.IsolatedAsyncioTestCase):
    async def test_waits_until_exact_revision_is_ready(self) -> None:
        source = SequenceSource(["NOT_FOUND", "BUILDING", "READY"])
        sleeps = []

        async def fake_sleep(seconds):
            sleeps.append(seconds)

        result = await wait_for_production_revision(
            source,
            "prj_example",
            "abcdef1234567890",
            attempts=3,
            delay_seconds=10,
            sleep=fake_sleep,
        )

        self.assertEqual(result.status, "ready")
        self.assertEqual(result.exit_code, 0)
        self.assertEqual(result.attempts, 3)
        self.assertEqual(sleeps, [10, 10])

    async def test_failed_exact_revision_stops_immediately(self) -> None:
        source = SequenceSource(["ERROR"])

        async def fail_if_called(_seconds):
            raise AssertionError("sleep should not be called")

        result = await wait_for_production_revision(
            source,
            "prj_example",
            "abcdef1234567890",
            attempts=3,
            sleep=fail_if_called,
        )

        self.assertEqual(result.status, "deployment_failed")
        self.assertEqual(result.severity, "P2")
        self.assertEqual(result.error_type, "VercelDeploymentFailed")
        self.assertEqual(result.exit_code, 2)

    async def test_timeout_fails_closed(self) -> None:
        source = SequenceSource(["NOT_FOUND", "BUILDING"])

        async def fake_sleep(_seconds):
            return None

        result = await wait_for_production_revision(
            source,
            "prj_example",
            "abcdef1234567890",
            attempts=2,
            delay_seconds=0,
            sleep=fake_sleep,
        )

        self.assertEqual(result.status, "deployment_timeout")
        self.assertEqual(result.error_type, "VercelDeploymentTimeout")
        self.assertEqual(result.exit_code, 2)


if __name__ == "__main__":
    unittest.main()
