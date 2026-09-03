import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

declare global {
  interface Window { openai?: any }
}

type OfficeData = Record<string, any>;

const fallbackTeam = [
  ['👑', 'Operations Manager'], ['🛠', 'Engineering & Reliability'], ['🎧', 'Customer Support'], ['💳', 'Billing & Subscriptions'],
  ['📣', 'Marketing & Growth'], ['📱', 'Social Media'], ['🤝', 'Café Sales'], ['📊', 'Analytics & Product'],
].map(([icon, name], index) => ({ id: String(index), icon, name, status: 'ready', mode: index === 0 ? 'coordinate_prioritize_escalate' : 'analyze_draft_recommend' }));

function structuredContent(value: any): OfficeData | null {
  return value?.structuredContent || value?.result?.structuredContent || value?.toolOutput || value?.output || null;
}

function useOfficeData() {
  const [data, setData] = useState<OfficeData>(() => structuredContent(window.openai) || {});
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const current = structuredContent(window.openai);
    if (current) setData(current);
    const onMessage = (event: MessageEvent) => {
      const message = event.data;
      if (message?.method !== 'ui/notifications/tool-result') return;
      const next = structuredContent(message?.params) || structuredContent(message?.params?.result);
      if (next) setData(next);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    if (!window.openai?.callTool) return;
    setLoading(true);
    try {
      const result = await window.openai.callTool(name, args);
      const next = structuredContent(result);
      if (next) setData(next);
    } finally { setLoading(false); }
  };

  const followUp = async (prompt: string) => {
    if (window.openai?.sendFollowUpMessage) await window.openai.sendFollowUpMessage({ prompt });
  };

  return { data, loading, call, followUp };
}

function show(value: unknown, fallback = '—') {
  return value === null || value === undefined || value === '' ? fallback : String(value);
}

function App() {
  const { data, loading, call, followUp } = useOfficeData();
  const metrics = data.business?.metrics || {};
  const health = data.health || {};
  const support = data.support || {};
  const billing = data.billing || {};
  const decisions = useMemo(() => data.decisions || data.items || (data.item ? [data.item] : []), [data]);
  const agents = Array.isArray(data.agents) ? data.agents.map((agent: any, index: number) => ({ ...fallbackTeam[index], ...agent })) : fallbackTeam;
  const billingAttention = Number(billing.subscriptions?.past_due || 0) + Number(billing.payments?.failed || 0);

  return <main>
    <header>
      <div><small>BARISTA JOB MATCH</small><h1>AI Office</h1><p>Owner Command Center</p></div>
      <span className="live">● {loading ? 'Updating' : 'Supervised'}</span>
    </header>

    <section className="metrics">
      <article><label>Platform</label><b>{show(health.overall || data.business?.status, 'Ready')}</b><span>Private system health</span></article>
      <article><label>Support</label><b>{show(support.open, 'Ready')}</b><span>{typeof support.open === 'number' ? 'Open requests' : 'Supervised triage'}</span></article>
      <article><label>Billing</label><b>{billingAttention || 'Protected'}</b><span>{billingAttention ? 'Items need review' : 'Owner-controlled'}</span></article>
      <article><label>Decisions</label><b>{show(data.approvals?.count ?? decisions.length, '0')}</b><span>Awaiting owner review</span></article>
    </section>

    {Object.keys(metrics).length > 0 && <section>
      <div className="title"><h2>Business Snapshot</h2><span>Live read-only counts</span></div>
      <div className="metrics compact">
        {['cafes', 'baristas', 'jobs', 'applications', 'subscriptions', 'payments'].map((key) => <article key={key}><label>{key}</label><b>{show(metrics[key])}</b></article>)}
      </div>
    </section>}

    <section>
      <div className="title"><h2>Your AI Team</h2><span>{agents.length} agents</span></div>
      <div className="team">{agents.map((agent: any, index: number) => <article key={agent.id || agent.name}>
        <i>{agent.icon || fallbackTeam[index]?.icon || '🤖'}</i><div><b>{agent.name}</b><span>{show(agent.status, 'ready')} · supervised</span></div><em>●</em>
      </article>)}</div>
    </section>

    <section className="split">
      <article className="panel">
        <div className="title"><h2>Needs Your Decision</h2><span>Protected actions only</span></div>
        {decisions.length ? <div className="decision-list">{decisions.map((item: any, index: number) => <div className="decision" key={`${item.title || item.action}-${index}`}>
          <span className={`severity ${String(item.severity || 'P2').toLowerCase()}`}>{show(item.severity, 'REVIEW')}</span>
          <div><b>{show(item.title || item.action, 'Owner review')}</b><p>{show(item.summary || item.reason, 'Review required before execution.')}</p><small>{show(item.agent, 'AI team')}</small></div>
        </div>)}</div> : <div className="empty"><b>No decision signals right now</b><p>Refunds, production changes, publishing, user actions and security changes will appear here for review.</p></div>}
      </article>

      <article className="panel">
        <div className="title"><h2>Reports</h2></div>
        <button onClick={() => call('get_owner_overview')}>Today's Owner Brief</button>
        <button onClick={() => call('get_system_health')}>System Health</button>
        <button onClick={() => call('get_decision_queue')}>Decision Queue</button>
        <button onClick={() => call('get_billing_summary')}>Billing & Subscriptions</button>
        <button onClick={() => call('get_ai_team_status')}>AI Team Status</button>
      </article>
    </section>

    <section>
      <div className="title"><h2>Quick Commands</h2></div>
      <div className="commands">
        <button onClick={() => call('get_owner_overview')}>Run AI Team</button>
        <button onClick={() => followUp('Ask the BJM Operations Manager what needs my attention today.')}>Ask Manager</button>
        <button onClick={() => call('get_system_health')}>Check Website</button>
        <button onClick={() => call('get_decision_queue')}>Check Decisions</button>
        <button onClick={() => followUp('Have the BJM Marketing Agent prepare this week’s growth plan. Draft only; do not publish or spend money.')}>Marketing Plan</button>
      </div>
    </section>

    <footer>Consequential actions require owner approval. Provider credentials remain server-side.</footer>
  </main>;
}

createRoot(document.getElementById('root')!).render(<App />);
