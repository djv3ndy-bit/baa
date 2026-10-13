import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { teamSnapshot } from './policy.js';
import { createOfficeProviders } from './providers.js';
import { notionConfigured } from './notion.js';

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
  const styleUrl = new URL('/assets/office.css', `${baseUrl}/`).toString();
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="${styleUrl}"></head><body><div id="root"></div><script type="module" src="${assetUrl}"></script></body></html>`;
}

export function createOfficeMcpServer(accessToken?: string) {
  const { getLiveOverview, getSupportSummary, getBillingSummary, getSystemHealth, getDecisionSignals } = createOfficeProviders(accessToken);
  const server = new McpServer({ name: 'bjm-ai-office', version: '0.4.1' });
  const baseUrl = officeBaseUrl();
  const resourceOrigin = new URL(baseUrl).origin;
  const toolMeta = {
    ui: { resourceUri: WIDGET_URI }, 'openai/outputTemplate': WIDGET_URI,
    securitySchemes: [{ type: 'oauth2', scopes: ['openid'] }],
  };

  server.registerResource('bjm-ai-office-widget', WIDGET_URI, {}, async () => ({ contents: [{ uri: WIDGET_URI, mimeType: 'text/html;profile=mcp-app', text: widgetHtml(), _meta: { ui: { prefersBorder: true, csp: { connectDomains: [resourceOrigin], resourceDomains: [resourceOrigin] } }, 'openai/widgetDescription': 'Private Barista Job Match AI Office for owner reports, team status, and approval decisions.' } }] }));

  server.registerTool('get_owner_overview', { title: 'BJM Owner Overview', description: 'Use this when the owner wants the AI Office overview. Unconfigured providers are not verified live business data.', inputSchema: {}, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, _meta: toolMeta }, async () => {
    const [business, support, billing, health, decisions] = await Promise.all([getLiveOverview(), getSupportSummary(), getBillingSummary(), getSystemHealth(), getDecisionSignals()]);
    return { structuredContent: { screen: 'overview', business, support, billing, health, notion: { configured: notionConfigured() }, approvals: { count: decisions.filter((item) => item.protected).length }, decisions }, content: [{ type: 'text', text: 'Loaded the BJM owner overview. Check provider availability before treating any metric as live; unavailable data is not a verified zero.' }] };
  });

  server.registerTool('get_ai_team_status', { title: 'AI Team Status', description: 'Use this when the owner wants the registered Barista Job Match AI team and permission ceilings. Registry entries do not prove active background execution.', inputSchema: {}, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, _meta: toolMeta }, async () => ({ structuredContent: { screen: 'team', agents: teamSnapshot() }, content: [{ type: 'text', text: 'Loaded the BJM AI team registry and operating modes.' }] }));

  server.registerTool('get_decision_queue', { title: 'Owner Decision Queue', description: 'Use this when the owner asks what needs approval. Aggregates available safety signals but never executes a protected action.', inputSchema: {}, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, _meta: toolMeta }, async () => {
    const items = await getDecisionSignals();
    return { structuredContent: { screen: 'decisions', items }, content: [{ type: 'text', text: items.length ? `Loaded ${items.length} owner decision signal(s).` : 'No decision signals were returned; verify provider availability before interpreting this as an all-clear.' }] };
  });

  server.registerTool('get_system_health', { title: 'BJM System Health', description: 'Use this when the owner wants website and private provider configuration health.', inputSchema: {}, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true }, _meta: toolMeta }, async () => ({ structuredContent: { screen: 'health', health: await getSystemHealth(), notion: { configured: notionConfigured() } }, content: [{ type: 'text', text: 'Loaded BJM system health.' }] }));

  server.registerTool('get_billing_summary', { title: 'Billing Summary', description: 'Use this when the owner wants a billing summary. An unconfigured provider is unavailable, not a verified zero. This tool cannot charge, refund, cancel, or modify subscriptions.', inputSchema: {}, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, _meta: toolMeta }, async () => ({ structuredContent: { screen: 'billing', billing: await getBillingSummary() }, content: [{ type: 'text', text: 'Loaded the billing adapter response; check configured/availability before interpreting counts.' }] }));

  // No mutating tools in this read-only V1. In particular, do not register the
  // previous request_owner_action tool, which persisted Notion tasks.
  return server;
}
