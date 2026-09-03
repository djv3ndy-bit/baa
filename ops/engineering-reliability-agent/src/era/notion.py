from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path
from typing import Any, Callable, Mapping
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


NOTION_API_VERSION = "2025-09-03"
MAX_INPUT_BYTES = 2_000_000
MAX_ERROR_BODY_BYTES = 8_192
MAX_REQUEST_ATTEMPTS = 3
MAX_RETRY_DELAY_SECONDS = 8.0
RETRYABLE_HTTP_STATUSES = frozenset({429, 500, 502, 503, 504})


class NotionSyncError(RuntimeError):
    """Raised when the private Notion sync cannot complete."""

    def __init__(
        self,
        message: str,
        *,
        http_status: int | None = None,
        error_code: str | None = None,
        retryable: bool = False,
    ) -> None:
        super().__init__(message)
        self.http_status = http_status
        self.error_code = error_code
        self.retryable = retryable


def _load_json_object(path_value: str) -> dict[str, Any]:
    path = Path(path_value).resolve(strict=True)
    if not path.is_file() or path.stat().st_size > MAX_INPUT_BYTES:
        raise ValueError("Input must be a JSON file no larger than 2 MB")
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("Input JSON must be an object")
    return payload


def _clean_data_source_id(value: str) -> str:
    cleaned = value.strip()
    if cleaned.startswith("collection://"):
        cleaned = cleaned.removeprefix("collection://")
    if not cleaned or "/" in cleaned or len(cleaned) > 100:
        raise ValueError("A valid Notion data source ID is required")
    return cleaned


def _safe_notion_error_code(body: bytes) -> str | None:
    """Extract only Notion's machine error code, never its message/body."""
    if not body:
        return None
    try:
        payload = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    if not isinstance(payload, Mapping):
        return None
    raw_code = payload.get("code")
    if not isinstance(raw_code, str):
        return None
    cleaned = "".join(
        character
        for character in raw_code.strip()
        if character.isalnum() or character in {"_", "-", "."}
    )
    return cleaned[:100] or None


def _retry_delay_seconds(error: HTTPError, attempt: int) -> float:
    retry_after = error.headers.get("Retry-After") if error.headers else None
    if retry_after:
        try:
            return min(
                max(float(retry_after), 0.0),
                MAX_RETRY_DELAY_SECONDS,
            )
        except ValueError:
            pass
    return min(float(2 ** (attempt - 1)), MAX_RETRY_DELAY_SECONDS)


def _request_json(
    method: str,
    url: str,
    token: str,
    payload: Mapping[str, Any],
    *,
    opener: Callable[..., Any] = urlopen,
    sleeper: Callable[[float], None] = time.sleep,
    max_attempts: int = MAX_REQUEST_ATTEMPTS,
) -> dict[str, Any]:
    if not 1 <= max_attempts <= 5:
        raise ValueError("Notion request attempts must be between 1 and 5")

    body_bytes = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    for attempt in range(1, max_attempts + 1):
        request = Request(
            url,
            data=body_bytes,
            method=method,
            headers={
                "Authorization": f"Bearer {token}",
                "Notion-Version": NOTION_API_VERSION,
                "Content-Type": "application/json",
                "User-Agent": "BaristaMatch-Reliability-Agent/1.0",
            },
        )
        try:
            with opener(request, timeout=10) as response:
                response_body = response.read()
        except HTTPError as error:
            error_body = b""
            try:
                error_body = error.read(MAX_ERROR_BODY_BYTES)
            except Exception:
                error_body = b""
            finally:
                try:
                    error.close()
                except Exception:
                    pass
            status = int(error.code)
            error_code = _safe_notion_error_code(error_body)
            retryable = status in RETRYABLE_HTTP_STATUSES
            if retryable and attempt < max_attempts:
                sleeper(_retry_delay_seconds(error, attempt))
                continue
            raise NotionSyncError(
                f"Notion API returned HTTP {status}",
                http_status=status,
                error_code=error_code,
                retryable=retryable,
            ) from None
        except (URLError, TimeoutError) as error:
            if attempt < max_attempts:
                sleeper(min(float(2 ** (attempt - 1)), MAX_RETRY_DELAY_SECONDS))
                continue
            raise NotionSyncError(
                type(error).__name__,
                error_code="transport_error",
                retryable=True,
            ) from None

        if not response_body:
            return {}
        try:
            value = json.loads(response_body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise NotionSyncError(
                "Notion API returned invalid JSON",
                error_code="invalid_json",
            ) from None
        if not isinstance(value, dict):
            raise NotionSyncError(
                "Notion API returned an invalid response",
                error_code="invalid_response",
            )
        return value

    raise NotionSyncError(
        "Notion request exhausted retries",
        error_code="retry_exhausted",
        retryable=True,
    )


def _rich_text(value: str, *, limit: int = 1900) -> dict[str, Any]:
    return {"rich_text": [{"text": {"content": value[:limit]}}]}


def _title(value: str) -> dict[str, Any]:
    return {"title": [{"text": {"content": value[:200]}}]}


def _summary(package: Mapping[str, Any]) -> str:
    parts = [str(package.get("summary") or "Incident review requested.")]
    likely_cause = str(package.get("likely_cause") or "").strip()
    if likely_cause:
        parts.append(f"Likely cause: {likely_cause}")
    actions = package.get("recommended_actions")
    if isinstance(actions, list):
        safe_actions = [str(item).strip() for item in actions[:3] if str(item).strip()]
        if safe_actions:
            parts.append("Recommended: " + " | ".join(safe_actions))
    return "\n\n".join(parts)[:1900]


def _properties(
    package: Mapping[str, Any],
    *,
    event_key: str,
    source_url: str,
) -> dict[str, Any]:
    severity = str(package.get("severity") or "P2").upper()
    priority = {"P0": "Critical", "P1": "High", "P2": "Medium"}.get(
        severity, "Low"
    )
    owner_approval = bool(
        (package.get("repair") or {}).get("owner_approval_required", True)
        if isinstance(package.get("repair"), Mapping)
        else True
    )
    status = (
        "Waiting for Owner Approval"
        if owner_approval
        else "Detected"
    )
    properties: dict[str, Any] = {
        "Task": _title(str(package.get("title") or "Reliability incident")),
        "Status": {"select": {"name": status}},
        "Priority": {"select": {"name": priority}},
        "Area": {"select": {"name": "Website"}},
        "Agent": _rich_text("Engineering / Reliability Agent", limit=200),
        "Owner Approval Required": {"checkbox": owner_approval},
        "Summary": _rich_text(_summary(package)),
        "Source": {"select": {"name": "GitHub Actions"}},
        "Event Key": _rich_text(event_key, limit=200),
    }
    if source_url.startswith("https://github.com/"):
        properties["Source Link"] = {"url": source_url[:2000]}
    return properties


def sync_response_package(
    package: Mapping[str, Any],
    *,
    token: str,
    data_source_id: str,
    source_url: str,
    request_json: Callable[
        [str, str, str, Mapping[str, Any]], dict[str, Any]
    ] = _request_json,
) -> dict[str, Any]:
    """Create or refresh one private Notion task for a sanitized incident."""
    if not bool(package.get("incident")):
        return {"status": "skipped_healthy", "attempted": False}
    if not token.strip():
        return {"status": "configuration_required", "attempted": False}

    data_source = _clean_data_source_id(data_source_id)
    fingerprint = str(package.get("fingerprint") or "").strip()
    if not fingerprint or len(fingerprint) > 100:
        raise ValueError("Response package fingerprint is required")
    event_key = f"era:{fingerprint}"
    properties = _properties(package, event_key=event_key, source_url=source_url)

    query_url = f"https://api.notion.com/v1/data_sources/{data_source}/query"
    query = request_json(
        "POST",
        query_url,
        token,
        {
            "filter": {
                "property": "Event Key",
                "rich_text": {"equals": event_key},
            },
            "page_size": 1,
        },
    )
    results = query.get("results")
    existing = results[0] if isinstance(results, list) and results else None
    if isinstance(existing, Mapping) and existing.get("id"):
        page_id = str(existing["id"])
        updated = request_json(
            "PATCH",
            f"https://api.notion.com/v1/pages/{page_id}",
            token,
            {"properties": properties},
        )
        return {
            "status": "updated",
            "attempted": True,
            "event_key": event_key,
            "page_id": str(updated.get("id") or page_id),
            "url": updated.get("url"),
        }

    created = request_json(
        "POST",
        "https://api.notion.com/v1/pages",
        token,
        {
            "parent": {"data_source_id": data_source},
            "properties": properties,
        },
    )
    return {
        "status": "created",
        "attempted": True,
        "event_key": event_key,
        "page_id": created.get("id"),
        "url": created.get("url"),
    }


def _safe_failure(error: Exception) -> dict[str, Any]:
    failure: dict[str, Any] = {
        "status": "failed",
        "attempted": True,
        "error_type": type(error).__name__,
    }
    if isinstance(error, NotionSyncError):
        failure["retryable"] = error.retryable
        if error.http_status is not None:
            failure["http_status"] = error.http_status
        if error.error_code:
            failure["error_code"] = error.error_code
    return failure


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Sync a sanitized reliability incident to private Notion"
    )
    parser.add_argument("--input", required=True, help="Response package JSON path")
    parser.add_argument(
        "--source-url",
        default=os.getenv("NOTION_SOURCE_URL", ""),
        help="Private GitHub Actions run URL",
    )
    args = parser.parse_args()

    try:
        package = _load_json_object(args.input)
        result = sync_response_package(
            package,
            token=os.getenv("NOTION_API_TOKEN", ""),
            data_source_id=os.getenv("NOTION_AGENT_DATA_SOURCE_ID", ""),
            source_url=args.source_url,
        )
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0
    except Exception as error:
        print(
            json.dumps(_safe_failure(error), separators=(",", ":")),
            file=sys.stderr,
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
