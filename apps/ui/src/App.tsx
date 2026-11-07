import { useEffect, useState } from 'react';
import { NavLink, Route, Routes, useNavigate } from 'react-router-dom';
import { api } from './api';
import { Badge } from './components';
import CommandCenter from './pages/CommandCenter';
import Projects from './pages/Projects';
import GitHubOps from './pages/GitHubOps';
import Support from './pages/Support';
import Agents from './pages/Agents';
import Providers from './pages/Providers';
import Runs from './pages/Runs';
import Settings from './pages/Settings';
import Search from './pages/Search';

const NAV = [
  { to: '/', label: 'Command Center', icon: '◎', end: true },
  { to: '/projects', label: 'Projects & Repos', icon: '▤' },
  { to: '/github', label: 'GitHub Operations', icon: '⎇' },
  { to: '/support', label: 'Biza Miz Support', icon: '☰' },
  { to: '/agents', label: 'AI Brain & Agents', icon: '✦' },
  { to: '/providers', label: 'LLM / Provider Studio', icon: '⚙' },
  { to: '/runs', label: 'Runs, Logs & Evidence', icon: '▶' },
  { to: '/settings', label: 'Settings & Security', icon: '⛨' },
];

function TopBar(): JSX.Element {
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [health, setHealth] = useState<'ok' | 'down' | 'checking'>('checking');

  useEffect(() => {
    const check = () =>
      api.health()
        .then(() => setHealth('ok'))
        .catch(() => setHealth('down'));
    check();
    const timer = setInterval(check, 30_000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="topbar">
      <h1>Development Command Center</h1>
      <div className="spacer" />
      <input
        className="search-input"
        placeholder="Search tasks, projects, reports… (Enter)"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && q.trim()) navigate(`/search?q=${encodeURIComponent(q.trim())}`);
        }}
      />
      {health === 'ok' && <Badge color="green" dot>worker online</Badge>}
      {health === 'down' && <Badge color="red" dot>worker offline</Badge>}
      {health === 'checking' && <Badge color="gray" dot>checking…</Badge>}
    </div>
  );
}

export default function App(): JSX.Element {
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-logo">DC</div>
          <div>
            <div className="brand-title">Command Center</div>
            <div className="brand-sub">local-first · Windows-first</div>
          </div>
        </div>
        <nav className="nav">
          {NAV.map((item) => (
            <NavLink key={item.to} to={item.to} end={item.end} className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
              <span className="nav-icon">{item.icon}</span>
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-footer">
          Evidence-backed status only.<br />
          Consequential actions are approval-gated.<br />
          <span className="mono">issue #1 · phase 1+</span>
        </div>
      </aside>
      <main className="main">
        <TopBar />
        <div className="content">
          <Routes>
            <Route path="/" element={<CommandCenter />} />
            <Route path="/projects" element={<Projects />} />
            <Route path="/github" element={<GitHubOps />} />
            <Route path="/support" element={<Support />} />
            <Route path="/agents" element={<Agents />} />
            <Route path="/providers" element={<Providers />} />
            <Route path="/runs" element={<Runs />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/search" element={<Search />} />
            <Route path="/tasks" element={<Agents />} />
            <Route path="*" element={<CommandCenter />} />
          </Routes>
        </div>
      </main>
    </div>
  );
}
