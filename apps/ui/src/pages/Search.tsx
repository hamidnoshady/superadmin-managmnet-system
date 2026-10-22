import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { Card, EmptyState, SectionTitle } from '../components';

interface SearchResults {
  tasks: Array<{ id: string; title: string; status: string }>;
  projects: Array<{ id: string; name: string }>;
  support: Array<{ id: string; title: string; status: string }>;
  runs: Array<{ id: string; status: string; stage: string }>;
}

export default function Search(): JSX.Element {
  const [params] = useSearchParams();
  const q = params.get('q') ?? '';
  const [results, setResults] = useState<SearchResults | null>(null);

  useEffect(() => {
    if (!q) { setResults(null); return; }
    api.search(q).then((r) => setResults(r as unknown as SearchResults)).catch(() => setResults(null));
  }, [q]);

  return (
    <div>
      <SectionTitle title="Search results" hint={`query: "${q}" — across tasks, projects, support reports, and run history`} />
      {!results ? (
        <EmptyState>Type in the search box above and press Enter.</EmptyState>
      ) : (
        <div className="grid cols-2">
          <Card title={`Tasks (${results.tasks.length})`}>
            {results.tasks.length === 0 ? <div className="faint">No matches.</div> : results.tasks.map((t) => (
              <div key={t.id} style={{ padding: '6px 0', borderBottom: '1px solid rgba(36,50,86,0.5)' }}>
                <Link to="/agents">{t.title}</Link> <span className="faint">· {t.status}</span>
              </div>
            ))}
          </Card>
          <Card title={`Projects (${results.projects.length})`}>
            {results.projects.length === 0 ? <div className="faint">No matches.</div> : results.projects.map((p) => (
              <div key={p.id} style={{ padding: '6px 0', borderBottom: '1px solid rgba(36,50,86,0.5)' }}>
                <Link to="/projects">{p.name}</Link>
              </div>
            ))}
          </Card>
          <Card title={`Support reports (${results.support.length})`}>
            {results.support.length === 0 ? <div className="faint">No matches.</div> : results.support.map((s) => (
              <div key={s.id} style={{ padding: '6px 0', borderBottom: '1px solid rgba(36,50,86,0.5)' }}>
                <Link to="/support">{s.title}</Link> <span className="faint">· {s.status}</span>
              </div>
            ))}
          </Card>
          <Card title={`Runs (${results.runs.length})`}>
            {results.runs.length === 0 ? <div className="faint">No matches.</div> : results.runs.map((r) => (
              <div key={r.id} style={{ padding: '6px 0', borderBottom: '1px solid rgba(36,50,86,0.5)' }}>
                <Link to="/runs" className="mono">{r.id}</Link> <span className="faint">· {r.status} · {r.stage}</span>
              </div>
            ))}
          </Card>
        </div>
      )}
    </div>
  );
}
