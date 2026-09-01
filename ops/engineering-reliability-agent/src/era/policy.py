from __future__ import annotations

import fnmatch
from dataclasses import dataclass
from enum import StrEnum


class Action(StrEnum):
    READ_HEALTH = "read_health"
    READ_VERCEL = "read_vercel"
    READ_GITHUB = "read_github"
    READ_SUPABASE = "read_supabase"
    PREPARE_BRANCH_FIX = "prepare_branch_fix"
    RUN_ALLOWLISTED_TESTS = "run_allowlisted_tests"
    CREATE_DRAFT_PR = "create_draft_pr"
    UPDATE_DEPENDENCY = "update_dependency"
    MODIFY_WORKFLOW = "modify_workflow"
    MODIFY_DEPLOYMENT_CONFIG = "modify_deployment_config"
    MODIFY_PAYMENT_CODE = "modify_payment_code"
    PROPOSE_MIGRATION = "propose_migration"
    SEND_EXTERNAL_COMMUNICATION = "send_external_communication"
    PUSH_MAIN = "push_main"
    MERGE_PR = "merge_pr"
    DEPLOY_PRODUCTION = "deploy_production"
    PROMOTE_DEPLOYMENT = "promote_deployment"
    ROLLBACK_PRODUCTION = "rollback_production"
    EXECUTE_SQL = "execute_sql"
    APPLY_MIGRATION = "apply_migration"
    DELETE_PRODUCTION_DATA = "delete_production_data"
    MODIFY_RLS = "modify_rls"
    MODIFY_AUTH = "modify_auth"
    MODIFY_SECURITY_CONFIG = "modify_security_config"
    READ_SECRET = "read_secret"
    WRITE_SECRET = "write_secret"
    INVOKE_ACCOUNT_DELETION = "invoke_account_deletion"


class Decision(StrEnum):
    ALLOW = "allow"
    REQUIRE_OWNER_APPROVAL = "require_owner_approval"
    DENY = "deny"


@dataclass(frozen=True, slots=True)
class PolicyDecision:
    decision: Decision
    reason: str

    @property
    def allowed(self) -> bool:
        return self.decision is Decision.ALLOW


_ALLOWED = {
    Action.READ_HEALTH,
    Action.READ_VERCEL,
    Action.READ_GITHUB,
    Action.READ_SUPABASE,
    Action.PREPARE_BRANCH_FIX,
    Action.RUN_ALLOWLISTED_TESTS,
    Action.CREATE_DRAFT_PR,
}
_APPROVAL_REQUIRED = {
    Action.UPDATE_DEPENDENCY,
    Action.MODIFY_WORKFLOW,
    Action.MODIFY_DEPLOYMENT_CONFIG,
    Action.MODIFY_PAYMENT_CODE,
    Action.PROPOSE_MIGRATION,
    Action.SEND_EXTERNAL_COMMUNICATION,
}
_FORBIDDEN = set(Action) - _ALLOWED - _APPROVAL_REQUIRED

_FORBIDDEN_PATHS = (
    ".env",
    ".env.*",
    "**/.env",
    "**/.env.*",
    ".secrets/**",
    "**/.secrets/**",
    ".git/**",
    "**/.git/**",
    "api/delete-account.js",
    "supabase/**",
)
_APPROVAL_PATHS = (
    ".github/workflows/**",
    ".github/CODEOWNERS",
    "vercel.json",
    "package.json",
    "pnpm-lock.yaml",
    "**/package.json",
    "**/package-lock.json",
    "**/pyproject.toml",
    "**/Dockerfile",
    "api/billing.js",
    "api/_billing.js",
    "login.html",
    "signup.html",
    "reset-password.html",
    "mobile/lib/supabase.ts",
)


def evaluate_action(action: Action) -> PolicyDecision:
    if action in _ALLOWED:
        return PolicyDecision(
            Decision.ALLOW,
            "Action is within the branch-only read/test/review boundary.",
        )
    if action in _APPROVAL_REQUIRED:
        return PolicyDecision(
            Decision.REQUIRE_OWNER_APPROVAL,
            "Action is high risk and requires owner approval.",
        )
    if action in _FORBIDDEN:
        return PolicyDecision(
            Decision.DENY, "The agent is permanently prohibited from this action."
        )
    return PolicyDecision(Decision.DENY, "Unknown actions are denied by default.")


def evaluate_path(path: str) -> PolicyDecision:
    normalized = path.strip().replace("\\", "/")
    if normalized.startswith("./"):
        normalized = normalized[2:]
    if (
        not normalized
        or normalized.startswith("/")
        or ":" in normalized
        or normalized in {".", ".."}
        or normalized.startswith("../")
        or "/../" in normalized
        or "/./" in normalized
    ):
        return PolicyDecision(Decision.DENY, "Invalid or escaping repository path.")
    if any(fnmatch.fnmatch(normalized, pattern) for pattern in _FORBIDDEN_PATHS):
        return PolicyDecision(
            Decision.DENY, "Path is outside the agent's autonomous change boundary."
        )
    if any(fnmatch.fnmatch(normalized, pattern) for pattern in _APPROVAL_PATHS):
        return PolicyDecision(
            Decision.REQUIRE_OWNER_APPROVAL,
            "Path is high risk and requires owner approval before a proposed change.",
        )
    return PolicyDecision(
        Decision.ALLOW, "Path may be changed on an incident branch and reviewed by PR."
    )


def evaluate_branch(branch: str) -> PolicyDecision:
    normalized = branch.strip().lower()
    if normalized in {"main", "master", "production", "prod"}:
        return PolicyDecision(
            Decision.DENY, "Protected branches are never writable by the agent."
        )
    if not normalized.startswith("agent/era/") and not normalized.startswith("codex/"):
        return PolicyDecision(
            Decision.DENY, "Agent branches must use an approved namespace."
        )
    return PolicyDecision(Decision.ALLOW, "Branch is within the agent-owned namespace.")
