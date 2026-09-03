# Private Notion incident sync

The Engineering & Reliability Agent can copy sanitized incidents into the private **AI Agent Control Center** in Notion.

## What is synchronized

Only response packages marked as incidents are written. Healthy hourly checks are skipped. The response-package fingerprint becomes the `Event Key`, so repeat detections update one existing task instead of creating duplicates.

The task includes the sanitized title, summary, likely cause, up to three recommended actions, severity-derived priority, source workflow link, and whether owner approval is required.

## Required private configuration

Create a Notion internal integration that is restricted to the Barista Job Match Owner HQ, share the **AI Agent Control Center** database with that integration, and add its token as the GitHub Actions repository secret:

- `NOTION_API_TOKEN`

The data source ID is non-secret and is pinned in the workflow:

- `64a712d1-8a77-44da-8db5-6a80b9ace054`

Never place the token in source code, workflow YAML, issue comments, build artifacts, or screenshots.

## Safety boundaries

- No healthy-run spam
- No secrets in Notion or workflow artifacts
- No production deployment, merge, database, billing, user, or security action
- No automatic owner approval
- P0/P1/P2 incidents remain owner-reviewed
- Workflow only accepts completed monitor runs from this repository's `main` branch
