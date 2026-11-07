import { useEffect, useState } from 'react';
import type { Provider } from '@dcc/core';
import { api } from '../api';
import { Badge, Card, ProviderBadge, SectionTitle, timeAgo } from '../components';

export default function Providers(): JSX.Element {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = () => api.providers().then(setProviders);
  useEffect(() => { load(); }, []);

  const check = async (id: string) => {
    setBusy(id);
    try {
      const p = await api.checkProvider(id);
      setMessage(`Check complete for ${p.name}: ${p.status} — ${p.checkNotes ?? ''}`);
      load();
    } finally {
      setBusy(null);
    }
  };

  return (
    <div>
      <SectionTitle title="LLM / Provider Studio" hint="adapter architecture — a provider is only 'ready' after its execution path is tested" />
      {message && <div className="notice ok" style={{ marginBottom: 14 }}>{message}</div>}

      <div className="notice" style={{ marginBottom: 14 }}>
        Rules: connection status and capabilities are only claimed when verified in this environment. Cost/usage is shown only where the provider exposes it.
        “Freebuf” stays disabled until the owner confirms what it refers to (open question from issue #1).
      </div>

      <div className="grid cols-2">
        {providers.map((p) => (
          <Card
            key={p.id}
            title={p.name}
            right={
              <div className="row">
                <ProviderBadge status={p.enabled ? p.status : 'disabled'} />
                <button className="btn small" onClick={() => check(p.id)} disabled={busy === p.id}>
                  {busy === p.id ? 'Checking…' : 'Run connection check'}
                </button>
                <button
                  className="btn small"
                  onClick={async () => { await api.enableProvider(p.id, !p.enabled); load(); }}
                >
                  {p.enabled ? 'Disable' : 'Enable'}
                </button>
              </div>
            }
          >
            <div className="row wrap">
              <Badge color="blue">{p.kind}</Badge>
              <Badge color="gray">exec: {p.executionMethod}</Badge>
              <Badge color="gray">auth: {p.authMethod}</Badge>
            </div>

            <div className="divider" />
            <div className="faint">Capabilities:</div>
            <div className="row wrap" style={{ marginTop: 6 }}>
              {(['filesystem', 'terminal', 'testing', 'structuredOutput', 'cancellation', 'costVisibility'] as const).map((cap) => (
                <Badge key={cap} color={p.capabilities[cap] ? 'green' : 'gray'}>
                  {cap === 'structuredOutput' ? 'structured output' : cap === 'costVisibility' ? 'cost visibility' : cap}: {p.capabilities[cap] ? 'yes' : 'no'}
                </Badge>
              ))}
            </div>

            <div className="divider" />
            <div className="faint">Models: {p.models.length > 0 ? p.models.join(', ') : '—'}</div>
            <div className="faint">Prerequisites: {p.prerequisites.join('; ') || '—'}</div>
            <div className="faint">Limitations: {p.limitations.join('; ') || '—'}</div>

            {p.checkNotes && (
              <div className={`notice ${p.status === 'verified' ? 'ok' : p.status === 'unavailable' ? 'danger' : ''}`} style={{ marginTop: 10 }}>
                {p.checkNotes}
                <div className="faint" style={{ marginTop: 4 }}>last checked: {timeAgo(p.lastCheckedAt)}</div>
              </div>
            )}
          </Card>
        ))}
      </div>
    </div>
  );
}
