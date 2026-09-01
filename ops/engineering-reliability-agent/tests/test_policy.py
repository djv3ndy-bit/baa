import unittest

from era.policy import Action, Decision, evaluate_action, evaluate_branch, evaluate_path


class PolicyTests(unittest.TestCase):
    def test_permanently_forbidden_actions_are_denied(self) -> None:
        forbidden = {
            Action.PUSH_MAIN,
            Action.MERGE_PR,
            Action.DEPLOY_PRODUCTION,
            Action.PROMOTE_DEPLOYMENT,
            Action.ROLLBACK_PRODUCTION,
            Action.EXECUTE_SQL,
            Action.APPLY_MIGRATION,
            Action.DELETE_PRODUCTION_DATA,
            Action.MODIFY_RLS,
            Action.MODIFY_AUTH,
            Action.MODIFY_SECURITY_CONFIG,
            Action.READ_SECRET,
            Action.WRITE_SECRET,
            Action.INVOKE_ACCOUNT_DELETION,
        }
        for action in forbidden:
            with self.subTest(action=action):
                self.assertEqual(evaluate_action(action).decision, Decision.DENY)

    def test_high_risk_actions_require_owner_approval(self) -> None:
        for action in (
            Action.UPDATE_DEPENDENCY,
            Action.MODIFY_WORKFLOW,
            Action.MODIFY_DEPLOYMENT_CONFIG,
            Action.MODIFY_PAYMENT_CODE,
            Action.PROPOSE_MIGRATION,
            Action.SEND_EXTERNAL_COMMUNICATION,
        ):
            with self.subTest(action=action):
                self.assertEqual(
                    evaluate_action(action).decision,
                    Decision.REQUIRE_OWNER_APPROVAL,
                )

    def test_main_and_non_agent_namespaces_are_denied(self) -> None:
        self.assertEqual(evaluate_branch("main").decision, Decision.DENY)
        self.assertEqual(evaluate_branch("feature/unscoped").decision, Decision.DENY)
        self.assertEqual(
            evaluate_branch("agent/era/incident-123").decision, Decision.ALLOW
        )
        self.assertEqual(
            evaluate_branch("codex/engineering-reliability-agent").decision,
            Decision.ALLOW,
        )

    def test_protected_paths_are_denied(self) -> None:
        for path in (
            ".env.local",
            ".secrets/key.env",
            "nested/.env.local",
            "nested/.secrets/key.env",
            ".git/config",
            "api/delete-account.js",
            "supabase/migrations/20260101000000_change.sql",
            "../outside.txt",
            "C:/outside.txt",
            "nested/./file.txt",
        ):
            with self.subTest(path=path):
                self.assertEqual(evaluate_path(path).decision, Decision.DENY)

    def test_operational_configuration_requires_approval(self) -> None:
        for path in (
            ".github/workflows/ci.yml",
            "vercel.json",
            "package.json",
            "api/billing.js",
            "ops/engineering-reliability-agent/pyproject.toml",
        ):
            with self.subTest(path=path):
                self.assertEqual(
                    evaluate_path(path).decision,
                    Decision.REQUIRE_OWNER_APPROVAL,
                )


if __name__ == "__main__":
    unittest.main()
