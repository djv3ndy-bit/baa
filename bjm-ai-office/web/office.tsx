import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '@modelcontextprotocol/ext-apps';
import { Office } from './office-view.js';
import { mergeOfficeData, structuredContent, type OfficeData } from './office-data.js';
import './style.css';

declare global {
  interface Window { openai?: any }
}

function OwnerOffice() {
  const [data, setData] = useState<OfficeData>(() => structuredContent(window.openai) || {});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(Boolean(window.openai?.callTool));
  const bridge = useRef<App | null>(null);

  useEffect(() => {
    let active = true;
    const receive = (value: any) => {
      if (!active) return;
      if (value?.isError) { setError('The report could not be loaded. Try again or ask the owner to check access.'); return; }
      const next = structuredContent(value);
      if (next) { setData((previous) => mergeOfficeData(previous, next)); setError(null); }
    };
    receive(window.openai);
    // The legacy host emits this event when its tool output changes.
    const onGlobals = (event: Event) => receive((event as CustomEvent).detail?.globals);
    window.addEventListener('openai:set_globals', onGlobals);

    const app = new App({ name: 'BJM AI Office', version: '0.4.1' });
    app.ontoolresult = receive;
    app.onclose = () => {
      if (active) { bridge.current = null; setConnected(Boolean(window.openai?.callTool)); }
    };
    if (window.parent !== window) {
      void app.connect(undefined, { timeout: 10000 }).then(() => {
        if (active) { bridge.current = app; setConnected(true); }
        else void app.close();
      }).catch(() => {
        if (active) setConnected(Boolean(window.openai?.callTool));
      });
    }
    return () => {
      active = false;
      bridge.current = null;
      window.removeEventListener('openai:set_globals', onGlobals);
      void app.close();
    };
  }, []);

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    setLoading(true);
    setError(null);
    try {
      const result = bridge.current
        ? await bridge.current.callServerTool({ name, arguments: args })
        : window.openai?.callTool ? await window.openai.callTool(name, args) : null;
      if (!result || result.isError) throw new Error('Report unavailable');
      const next = structuredContent(result);
      if (!next) throw new Error('Report unavailable');
      setData((previous) => mergeOfficeData(previous, next));
    } catch {
      setError('The report could not be loaded. Try again or ask the owner to check access.');
    } finally { setLoading(false); }
  };

  const followUp = async (prompt: string) => {
    setError(null);
    try {
      if (bridge.current) {
        const result = await bridge.current.sendMessage({ role: 'user', content: [{ type: 'text', text: prompt }] });
        if (result.isError) throw new Error('Message unavailable');
      } else if (window.openai?.sendFollowUpMessage) await window.openai.sendFollowUpMessage({ prompt });
      else throw new Error('Message unavailable');
    } catch { setError('This command could not be sent to ChatGPT. Please try it in the chat.'); }
  };

  return <Office data={data} loading={loading} connected={connected} error={error} call={call} followUp={followUp} />;
}

createRoot(document.getElementById('root')!).render(<OwnerOffice />);
