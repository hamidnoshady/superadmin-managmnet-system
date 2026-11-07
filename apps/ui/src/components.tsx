import type { ReactNode } from 'react';
import type { SourcedStatus, StatusConfidence, TaskStatus } from '@dcc/core';

// ---------------------------------------------------------------------------
// Badge helpers
// ---------------------------------------------------------------------------

const STATUS_COLORS: Record<string, string> = {
  Incoming: 'gray',
  Triage: 'blue',
  Investigating: 'blue',
  Planned: 'purple',
  'Waiting for Approval': 'amber',
  Approved: 'green',
  'In Development': 'blue',
  Testing: 'purple',
  Review: 'purple',
  'Ready for Merge': 'green',
  Completed: 'green',
  Blocked: 'amber',
  Failed: 'red',
  Cancelled: 'gray',
};

export function statusColor(status: string): string {
  return STATUS_COLORS[status] ?? 'gray';
}

export function Badge({ color = 'gray', children, dot = false }: { color?: string; children: ReactNode; dot?: boolean }): JSX.Element {
  return (
    <span className={`badge ${color}`}>
      {dot && <span className="dot" />}
      {children}
    </span>
  );
}

export function TaskBadge({ status }: { status: TaskStatus | string }): JSX.Element {
  return <Badge color={statusColor(status)}>{status}</Badge>;
}

export function ExternalBadge({ value }: { value: string }): JSX.Element {
  const color =
    value === 'passing' || value === 'merged' ? 'green'
    : value === 'failing' ? 'red'
    : value === 'running' ? 'blue'
    : value === 'open' ? 'blue'
    : value === 'closed' ? 'gray'
    : value === 'draft' ? 'amber'
    : 'gray';
  return <Badge color={color}>{value}</Badge>;
}

export function SeverityBadge({ severity }: { severity: string }): JSX.Element {
  const color = severity === 'critical' || severity === 'high' ? 'red' : severity === 'medium' ? 'amber' : 'gray';
  return <Badge color={color}>{severity}</Badge>;
}

export function ProviderBadge({ status }: { status: string }): JSX.Element {
  const color =
    status === 'verified' ? 'green'
    : status === 'unverified' ? 'amber'
    : status === 'unavailable' ? 'red'
    : status === 'disabled' ? 'gray'
    : 'purple';
  return <Badge color={color} dot>{status}</Badge>;
}

export function ConfidenceBadge({ confidence, source, updatedAt }: { confidence: StatusConfidence; source: string; updatedAt: string | null }): JSX.Element {
  return (
    <span className="source-tag" title={`Source: ${source} · Updated: ${updatedAt ?? 'never'}`}>
      <span className={`confidence-${confidence}`}>●</span>
      {source}{updatedAt ? ` · ${timeAgo(updatedAt)}` : ' · never'}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Layout helpers
// ---------------------------------------------------------------------------

export function Card({ title, children, className = '', right }: { title?: string; children: ReactNode; className?: string; right?: ReactNode }): JSX.Element {
  return (
    <div className={`card ${className}`}>
      {(title || right) && (
        <div className="row" style={{ marginBottom: 12 }}>
          {title && <h3 style={{ margin: 0, flex: 1 }}>{title}</h3>}
          {right}
        </div>
      )}
      {children}
    </div>
  );
}

export function SectionTitle({ title, hint, right }: { title: string; hint?: string; right?: ReactNode }): JSX.Element {
  return (
    <div className="section-title">
      <h2>{title}</h2>
      {hint && <span className="hint">{hint}</span>}
      <div className="spacer" style={{ flex: 1 }} />
      {right}
    </div>
  );
}

export function EmptyState({ children }: { children: ReactNode }): JSX.Element {
  return <div className="empty">{children}</div>;
}

export function SourcedStatusRow({ item }: { item: SourcedStatus }): JSX.Element {
  return (
    <div className="row" style={{ justifyContent: 'space-between', padding: '7px 0', borderBottom: '1px solid rgba(36,50,86,0.5)' }}>
      <div>
        <strong style={{ fontSize: 12.5 }}>{item.label}</strong>
        <div className="faint">{item.value}</div>
      </div>
      <ConfidenceBadge confidence={item.confidence} source={item.source} updatedAt={item.updatedAt} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function timeAgo(iso: string | null): string {
  if (!iso) return 'never';
  const diff = Date.now() - new Date(iso).getTime();
  const sec = Math.round(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 48) return `${hr}h ago`;
  return `${Math.round(hr / 24)}d ago`;
}

export function shortSha(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 8) : '—';
}
