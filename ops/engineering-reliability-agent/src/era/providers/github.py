from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from typing import Any
from urllib.parse import quote, urlencode

from era.redaction import sanitize_text

from .http import JsonGetTransport, ProviderReadError, UrlLibJsonTransport


_REPOSITORY = re.compile(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+")
_FAILED_CONCLUSIONS = frozenset(
    {"action_required", "cancelled", "failure", "startup_failure", "timed_out"}
)


def _mapping(value: Any) -> Mapping[str, Any]:
    return value if isinstance(value, Mapping) else {}


def _sequence(value: Any) -> Sequence[Any]:
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return value
    return ()


class GitHubApiSource:
    """Read recent commits and checks through GitHub's REST API."""

    def __init__(
        self,
        token: str | None = None,
        *,
        transport: JsonGetTransport | None = None,
    ) -> None:
        if token and ("\n" in token or "\r" in token):
            raise ValueError("GitHub token contains invalid characters")
        self._token = token
        self._transport = transport or UrlLibJsonTransport(
            frozenset({"api.github.com"})
        )

    def _headers(self) -> dict[str, str]:
        headers = {
            "Accept": "application/vnd.github+json",
            "User-Agent": "BaristaMatch-ERA/0.1",
            "X-GitHub-Api-Version": "2026-03-10",
        }
        if self._token:
            headers["Authorization"] = f"Bearer {self._token}"
        return headers

    @staticmethod
    def _repository_path(repository: str) -> str:
        if not _REPOSITORY.fullmatch(repository):
            raise ValueError("GitHub repository must use the owner/name format")
        return quote(repository, safe="/")

    async def _get(self, path: str, query: Mapping[str, object] | None = None) -> Any:
        url = f"https://api.github.com{path}"
        if query:
            url = f"{url}?{urlencode(query)}"
        return await self._transport.get_json(url, headers=self._headers())

    async def _list_commits(
        self, repository: str, *, limit: int
    ) -> list[Mapping[str, Any]]:
        if not 1 <= limit <= 100:
            raise ValueError("GitHub result limit must be between 1 and 100")
        path = self._repository_path(repository)
        payload = await self._get(
            f"/repos/{path}/commits", {"per_page": limit, "page": 1}
        )
        if not isinstance(payload, list):
            raise ProviderReadError("GitHub returned an invalid commit list")
        return [item for item in payload if isinstance(item, Mapping)][:limit]

    async def list_recent_changes(
        self, repository: str, *, limit: int
    ) -> list[Mapping[str, Any]]:
        commits = await self._list_commits(repository, limit=limit)
        repository_path = self._repository_path(repository)
        changes: list[Mapping[str, Any]] = []
        for item in commits:
            sha = str(item.get("sha") or "")
            if not re.fullmatch(r"[0-9a-fA-F]{7,64}", sha):
                continue
            detail = _mapping(
                await self._get(f"/repos/{repository_path}/commits/{quote(sha)}")
            )
            commit = _mapping(item.get("commit"))
            committer = _mapping(commit.get("committer"))
            author = _mapping(commit.get("author"))
            committed_at = committer.get("date") or author.get("date")
            if not committed_at:
                continue
            message = str(commit.get("message") or "Untitled change").splitlines()[0]
            files = tuple(
                str(file.get("filename"))
                for file in _sequence(detail.get("files"))[:100]
                if isinstance(file, Mapping) and file.get("filename")
            )
            changes.append(
                {
                    "sha": sha,
                    "committed_at": committed_at,
                    "title": sanitize_text(message, max_length=200),
                    "files": files,
                }
            )
        return changes

    async def list_failed_checks(
        self, repository: str, *, limit: int
    ) -> list[Mapping[str, Any]]:
        commits = await self._list_commits(repository, limit=min(limit, 10))
        repository_path = self._repository_path(repository)
        failures: list[Mapping[str, Any]] = []
        for item in commits:
            sha = str(item.get("sha") or "")
            if not re.fullmatch(r"[0-9a-fA-F]{7,64}", sha):
                continue
            payload = _mapping(
                await self._get(
                    f"/repos/{repository_path}/commits/{quote(sha)}/check-runs",
                    {"filter": "latest", "status": "completed", "per_page": 100},
                )
            )
            for check in _sequence(payload.get("check_runs")):
                if not isinstance(check, Mapping):
                    continue
                conclusion = str(check.get("conclusion") or "").lower()
                if conclusion not in _FAILED_CONCLUSIONS:
                    continue
                name = sanitize_text(
                    str(check.get("name") or "unnamed check"), max_length=120
                )
                failures.append(
                    {
                        "id": f"github-check-{check.get('id') or len(failures)}",
                        "occurred_at": check.get("completed_at")
                        or check.get("started_at"),
                        "summary": f"GitHub check failed: {name}",
                        "commit_sha": sha,
                        "check_name": name,
                        "conclusion": conclusion,
                    }
                )
                if len(failures) >= limit:
                    return failures
        return failures
