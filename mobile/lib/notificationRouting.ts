const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function notificationDestination(data: Record<string, unknown> | undefined): string | null {
  if (!data) return null;
  if (data.type === 'job' && typeof data.jobId === 'string' && uuid.test(data.jobId)) return `/discover?jobId=${data.jobId}`;
  if (typeof data.route !== 'string') return null;
  if (['/home', '/discover', '/matches', '/messages', '/candidates', '/jobs', '/profile'].includes(data.route)) return data.route;
  const chat = data.route.match(/^\/chat\/([^/?#]+)(?:\?kind=(application|discovery))?$/);
  if (!chat || !uuid.test(chat[1])) return null;
  return `/chat/${chat[1]}?kind=${chat[2] || 'application'}`;
}
