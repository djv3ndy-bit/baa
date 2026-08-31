import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
REPOSITORY_ROOT = ROOT.parents[1]


class PackageSafetyTests(unittest.TestCase):
    def test_documented_and_packaged_prompts_match(self) -> None:
        documented = (ROOT / "docs" / "prompt.md").read_text(encoding="utf-8")
        packaged = (ROOT / "src" / "era" / "prompt.md").read_text(encoding="utf-8")
        self.assertEqual(documented, packaged)

    def test_agent_env_template_never_requests_production_service_keys(self) -> None:
        template = (ROOT / ".env.example").read_text(encoding="utf-8")
        for forbidden in (
            "SUPABASE_SECRET_KEY",
            "SUPABASE_SERVICE_ROLE_KEY",
            "STRIPE_SECRET_KEY",
            "RESEND_API_KEY",
            "VERCEL_TOKEN=",
        ):
            with self.subTest(forbidden=forbidden):
                self.assertNotIn(forbidden, template)

    def test_provider_clients_do_not_define_mutating_http_methods(self) -> None:
        provider_root = ROOT / "src" / "era" / "providers"
        source = "\n".join(
            path.read_text(encoding="utf-8")
            for path in sorted(provider_root.glob("*.py"))
        )
        for method in ("POST", "PUT", "PATCH", "DELETE"):
            with self.subTest(method=method):
                self.assertNotIn(f'method="{method}"', source)
        self.assertIn('method="GET"', source)

    def test_recurring_workflow_is_read_only_and_model_free(self) -> None:
        workflow = (
            REPOSITORY_ROOT
            / ".github"
            / "workflows"
            / "engineering-reliability-monitor.yml"
        ).read_text(encoding="utf-8")

        self.assertIn("contents: read", workflow)
        self.assertIn("checks: read", workflow)
        self.assertIn("persist-credentials: false", workflow)
        self.assertNotIn("contents: write", workflow)
        self.assertNotIn("OPENAI_API_KEY", workflow)
        job_header = workflow.split("    steps:", 1)[0]
        self.assertNotIn("READ_TOKEN", job_header)
        for forbidden in (
            "git push",
            "vercel deploy",
            "supabase db",
            "pull-requests: write",
            "deployments: write",
            "issues: write",
        ):
            with self.subTest(forbidden=forbidden):
                self.assertNotIn(forbidden, workflow)

        action_references = re.findall(r"uses:\s+[^\s]+@([^\s]+)", workflow)
        self.assertTrue(action_references)
        self.assertTrue(
            all(re.fullmatch(r"[0-9a-f]{40}", ref) for ref in action_references)
        )


if __name__ == "__main__":
    unittest.main()
