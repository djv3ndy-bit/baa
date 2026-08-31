import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


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


if __name__ == "__main__":
    unittest.main()
