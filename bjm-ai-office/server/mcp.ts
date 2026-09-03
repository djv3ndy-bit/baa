import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ownerApprovalFor, teamSnapshot } from './policy.js';
import { getLiveOverview, getSupportSummary, getBillingSummary, getSystemHealth, getDecisionSignals } from './providers.js';
import { createNotionAgentTask, notionConfigured } from './notion.js';

const WIDGET_URI = 'ui://bjm-ai-office/owner-v1';

function cleanBaseUrl(value: string) { return String(value || '').trim().replace(/\/$/, ''); }
export function officeBaseUrl() {
  const explicit = cleanBaseUrl(process.env.BJM_OFFICE_BASE_URL || '');
  if (explicit) return explicit;
  const vercelHost = String(process.env.VERCEL_URL || process.env.VERCEL_PROJECT_PRODUCTION_URL || '').trim();
  if (vercelHost) return `https://${vercelHost.replace(/^https?:\/\//, '').replace(/\/$/, '')}`;
  return 'http://localhost:8787';
}
function widgetHtml() {
  const baseUrl = officeBaseUrl();
  const assetUrl = new URL('/assets/office.js', `${baseUrl}/`).toString();
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="${assetUrl}"></script></body></html>`;
}

export function createOfficeMcpServer() {
  const server = new McpServer({ name: 'bjm-ai-office', version: '0.4.0' });
  const baseUrl = officeBaseUrl();
  const resourceOrigin = new URL(baseUrl).origin;
  const toolMeta = { ui: { resourceUri: WIDGET_URI }, 'openai/outputTemplate': WIDGET_URI };

  server.registerResource('bjm-ai-office-widget', WIDGET_URI, {}, async () => ({ contents: [{ uri: WIDGET_URI, mimeType: 'text/html;profile=mcp-app', text: widgetHtml(), _meta: { ui: { prefersBorder: true, csp: { connectDomains: [resourceOrigin], resourceDomains: [resourceOrigin] } }, 'openai/widgetDescription': 'Private Barista Job Match AI Office for owner reports, team status, and approval decisions.' } }] }));

  server.registerTool('get_owner_overview', { title: 'BJM Owner Overview', description: 'Use this when the owner wants the live AI Office overview, business counts, support and billing summaries, system health, and approval signals.', inputSchema: {}, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, _meta: toolMeta }, async () => {
    const [business, support, billing, health, decisions] = await Promise.all([getLiveOverview(), getSupportSummary(), getBillingSummary(), getSystemHealth(), getDecisionSignals()]);
    return { structuredContent: { screen: 'overview', business, support, billing, health, notion: { configured: notionConfigured() }, approvals: { count: decisions.filter((item) => item.protected).length }, decisions }, content: [{ type: 'text', text: 'Loaded the live BJM owner overview. Sensitive provider credentials remain server-side.' }] };
  });

  server.registerTool('get_ai_team_status', { title: 'AI Team Status', description: 'Use this when the owner wants to see the Barista Job Match AI team and each agent operating mode.', inputSchema: {}, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, _meta: toolMeta }, async () => ({ structuredContent: { screen: 'team', agents: teamSnapshot() }, content: [{ type: 'text', text: 'Loaded the BJM AI team.' }] }));

  server.registerTool('get_decision_queue', { title: 'Owner Decision Queue', description: 'Use this when the owner asks what needs approval. Aggregates live safety signals but never executes a protected action.', inputSchema: {}, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, _meta: toolMeta }, async () => {
    const items = await getDecisionSignals();
    return { structuredContent: { screen: 'decisions', items }, content: [{ type: 'text', text: items.length ? `Loaded ${items.length} owner decision signal(s).` : 'No current decision signals were detected.' }] };
  });

  server.registerTool('get_system_health', { title: 'BJM System Health', description: 'Use this when the owner wants website and private provider configuration health.', inputSchema: {}, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true }, _meta: toolMeta }, async () => ({ structuredContent: { screen: 'health', health: await getSystemHealth(), notion: { configured: notionConfigured() } }, content: [{ type: 'text', text: 'Loaded BJM system health.' }] }));

  server.registerTool('get_billing_summary', { title: 'Billing Summary', description: 'Use this when the owner wants a read-only billing and subscription summary. This tool cannot charge, refund, cancel, or modify subscriptions.', inputSchema: {}, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, _meta: toolMeta }, async () => ({ structuredContent: { screen: 'billing', billing: await getBillingSummary() }, content: [{ type: 'text', text: 'Loaded the read-only billing summary.' }] }));

  server.registerTool('request_owner_action', {
    title: 'Prepare Owner Approval',
    description: 'Use this when an agent has a proposed action. Classifies owner approval and records the review item in the private Notion control center when configured; it never executes the protected action.',
    inputSchema: { action: z.string().min(1).max(500), agent: z.string().min(1).max(80), summary: z.string().min(1).max(1500), area: z.enum(['Website','iOS App','Authentication','Payments','Database','Email','Support','Marketing','Security']).optional(), priority: z.enum(['Critical','High','Medium','Low']).optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }, _meta: toolMeta,
  }, async ({ action, agent, summary, area, priority }) => {
    const policy = ownerApprovalFor(action);
    const status = policy.approvalRequired ? 'Waiting for Owner Approval' : 'Fix Prepared';
    const notion = await createNotionAgentTask({ task: action, status, priority: priority || (policy.approvalRequired ? 'High' : 'Medium'), area, agent, ownerApprovalRequired: policy.approvalRequired, summary });
    return { structuredContent: { screen: 'decision', item: { action, agent, summary, ...policy, status: policy.approvalRequired ? 'owner_review' : 'routine' }, notion }, content: [{ type: 'text', text: policy.approvalRequired ? 'Owner approval is required. The review item was prepared; no protected action was executed.' : 'Routine internal work was prepared; no external action was executed.' }] };
  });

  return server;
}
