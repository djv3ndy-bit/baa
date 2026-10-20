import React from 'react';
import { teamSnapshot } from '../server/policy.js';
import { billingMetric, show, supportMetric, type OfficeData } from './office-data.js';

const icons: Record<string, string> = { manager: '👑', engineering: '🛠', security: '🔐', support: '🎧', billing: '💳', marketing: '📣', sales: '🤝', finance: '📊', release: '📱' };
const registeredTeam = teamSnapshot();

type Props = {
  data: OfficeData;
  loading: boolean;
  connected: boolean;
  error: string | null;
  call: (name: string) => unknown;
  followUp: (prompt: string) => unknown;
};

export function Office({ data, loading, connected, error, call, followUp }: Props) {
  const metrics = data.business?.metrics || {};
  const decisions = Array.isArray(data.decisions) ? data.decisions : Array.isArray(data.items) ? data.items : [];
  const decisionsLoaded = Array.isArray(data.decisions) || Array.isArray(data.items);
  const agents = Array.isArray(data.agents) ? data.agents : registeredTeam;
  const support = supportMetric(data.support);
  const billing = billingMetric(data.billing);
  const disabled = loading || !connected;

  return <main>
    <header>
      <div><small>BARISTA JOB MATCH</small><h1>AI Office</h1><p>Owner Command Center</p></div>
      <span className="live">{loading ? 'Updating' : 'Read-only Office'}</span>
    </header>
    {!connected && <p className="notice" role="status">Open this Office in a connected ChatGPT app to load reports.</p>}
    {error && <p className="notice error" role="alert">{error}</p>}

    <section className="metrics">
      <article><label>Platform</label><b>{show(data.health?.overall, 'Not loaded')}</b><span>Website and private data checks</span></article>
      <article><label>Support</label><b>{support.value}</b><span>{support.detail}</span></article>
      <article><label>Billing</label><b>{billing.value}</b><span>{billing.detail}</span></article>
      <article><label>Decisions</label><b>{decisionsLoaded ? decisions.filter((item: any) => item.protected).length : 'Not loaded'}</b><span>Protected signals for owner review</span></article>
    </section>

    {Object.keys(metrics).length > 0 && <section>
      <div className="title"><h2>Business Snapshot</h2><span>Read-only counts · {show(data.business?.availability, 'availability unverified').replaceAll('_', ' ')}</span></div>
      <div className="metrics compact">
        {['cafes', 'baristas', 'jobs', 'applications', 'subscriptions', 'payments'].map((key) => <article key={key}><label>{key}</label><b>{show(metrics[key])}</b></article>)}
      </div>
    </section>}

    <section>
      <div className="title"><h2>Your AI Team</h2><span>{agents.length} registered roles</span></div>
      <p className="team-note">Roles are available on request. The registry does not indicate active background work.</p>
      <div className="team">{agents.map((agent: any) => <article key={agent.id || agent.name}>
        <i>{icons[agent.id] || '🤖'}</i><div><b>{agent.name}</b><span>{show(agent.status, 'registered').replaceAll('_', ' ')} · {show(agent.permissionCeiling, 'observe')} ceiling</span></div>
      </article>)}</div>
    </section>

    <section className="split">
      <article className="panel">
        <div className="title"><h2>Needs Your Decision</h2><span>Available review signals</span></div>
        {decisions.length ? <div className="decision-list">{decisions.map((item: any, index: number) => <div className="decision" key={`${item.title || item.action}-${index}`}>
          <span className={`severity ${String(item.severity || 'P2').toLowerCase()}`}>{show(item.severity, 'REVIEW')}</span>
          <div><b>{show(item.title || item.action, 'Owner review')}</b><p>{show(item.summary || item.reason, 'Review required before execution.')}</p><small>{show(item.agent, 'AI team')}</small></div>
        </div>)}</div> : <div className="empty"><b>{decisionsLoaded ? 'No decision signals returned' : 'Decision queue not loaded'}</b><p>{decisionsLoaded ? 'This reflects available checks. Verify provider availability before treating it as an all-clear.' : 'Load the owner brief or decision queue to check what needs review.'}</p></div>}
      </article>

      <article className="panel">
        <div className="title"><h2>Reports</h2></div>
        <button disabled={disabled} onClick={() => call('get_owner_overview')}>Today's Owner Brief</button>
        <button disabled={disabled} onClick={() => call('get_system_health')}>System Health</button>
        <button disabled={disabled} onClick={() => call('get_decision_queue')}>Decision Queue</button>
        <button disabled={disabled} onClick={() => call('get_billing_summary')}>Billing &amp; Subscriptions</button>
        <button disabled={disabled} onClick={() => call('get_ai_team_status')}>AI Team Registry</button>
      </article>
    </section>

    <section>
      <div className="title"><h2>Quick Commands</h2></div>
      <div className="commands">
        <button disabled={disabled} onClick={() => call('get_owner_overview')}>Refresh Owner Brief</button>
        <button disabled={disabled} onClick={() => followUp('Use the BJM owner overview and team registry to prepare an Operations Manager brief on what needs my attention today. State any unavailable data. Draft only.')}>Ask Manager</button>
        <button disabled={disabled} onClick={() => call('get_system_health')}>Check Website</button>
        <button disabled={disabled} onClick={() => call('get_decision_queue')}>Check Decisions</button>
        <button disabled={disabled} onClick={() => followUp('Use the BJM Marketing & Growth role to draft this week’s growth plan from available evidence. State any unavailable data. Do not publish or spend money.')}>Draft Marketing Plan</button>
      </div>
    </section>

    <footer>Consequential actions require owner approval. Provider credentials remain server-side.</footer>
  </main>;
}
