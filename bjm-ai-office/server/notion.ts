type NotionTaskInput = {
  task: string;
  status?: 'Detected' | 'Investigating' | 'Fix Prepared' | 'Waiting for Owner Approval' | 'Approved' | 'Deployed' | 'Verified' | 'Rejected';
  priority?: 'Critical' | 'High' | 'Medium' | 'Low';
  area?: 'Website' | 'iOS App' | 'Authentication' | 'Payments' | 'Database' | 'Email' | 'Support' | 'Marketing' | 'Security';
  agent?: string;
  ownerApprovalRequired?: boolean;
  summary?: string;
};

const env = (name: string) => String(process.env[name] || '').trim();

export function notionConfigured() {
  return Boolean(env('NOTION_API_TOKEN') && env('NOTION_AGENT_DATA_SOURCE_ID'));
}

export async function createNotionAgentTask(input: NotionTaskInput) {
  if (!notionConfigured()) {
    return { ok: false, status: 'configuration_required' as const };
  }

  const properties: Record<string, unknown> = {
    Task: { title: [{ text: { content: input.task.slice(0, 200) } }] },
    Status: { select: { name: input.status || 'Detected' } },
    Priority: { select: { name: input.priority || 'Medium' } },
    'Owner Approval Required': { checkbox: Boolean(input.ownerApprovalRequired) },
  };

  if (input.area) properties.Area = { select: { name: input.area } };
  if (input.agent) properties.Agent = { rich_text: [{ text: { content: input.agent.slice(0, 200) } }] };
  if (input.summary) properties.Summary = { rich_text: [{ text: { content: input.summary.slice(0, 1900) } }] };

  const response = await fetch('https://api.notion.com/v1/pages', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env('NOTION_API_TOKEN')}`,
      'Notion-Version': '2025-09-03',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      parent: { data_source_id: env('NOTION_AGENT_DATA_SOURCE_ID') },
      properties,
    }),
    signal: AbortSignal.timeout(5000),
  });

  if (!response.ok) {
    return { ok: false, status: 'notion_write_failed' as const, httpStatus: response.status };
  }

  const data: any = await response.json();
  return { ok: true, status: 'created' as const, pageId: data.id, url: data.url };
}
