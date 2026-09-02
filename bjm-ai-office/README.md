# BJM AI Office

Private/internal ChatGPT App for the Barista Job Match owner.

## Product shape

Primary archetype: **interactive-decoupled** ChatGPT App (MCP server + React widget).

This is intentionally separate from the customer-facing Barista Job Match website/app. ChatGPT/BJM Office is the owner control center.

## V1 owner experience

- Owner Overview: platform/support/billing/approval summary
- AI Team: Manager, Engineering, Support, Billing, Marketing, Social, Sales, Analytics
- Decision Queue: protected actions requiring owner approval
- Reports: owner brief, support, billing, growth, system health
- Quick Commands: run team, ask manager, check support, check health, create marketing plan
- Emergency controls are represented as protected actions, never silent autonomous writes

## Safety contract

Read-only/reporting tools are safe by default. Mutating actions must be separate MCP tools with accurate destructive/idempotent annotations and explicit owner confirmation. No secrets are placed in widget code. No public customer UI is added to baristajobmatch.com.

## Planned MCP tools

- `get_owner_overview` — read-only summary
- `get_ai_team_status` — read-only agent status/capabilities
- `get_decision_queue` — read-only pending approvals
- `get_reports` — read-only reports
- `run_owner_brief` — read-only orchestration/report generation
- `request_owner_action` — creates a reviewable approval request; does not execute protected action
- later: narrowly scoped approved-action tools for merge/deploy/refund/publish/etc., each with explicit confirmation

## Data adapters

The server layer should call private backend adapters for Supabase, GitHub, Vercel, Resend and Stripe-derived billing data. The widget receives concise structured content; credentials and sensitive provider payloads stay server-side.

## Docs alignment

Build against current OpenAI Apps SDK guidance: MCP server + widget UI, tool-first design, accurate annotations, structuredContent for model/widget, widget-only metadata in `_meta`, MCP Apps bridge first, and exact CSP allowlists before deployment.
