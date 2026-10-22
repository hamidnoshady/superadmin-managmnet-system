import type { SourcedStatus, StatusConfidence } from './types.js';

/**
 * Evidence-backed status display.
 *
 * Product principle: "Every status must have a source and last-updated time.
 * Distinguish confirmed state from inferred recommendations and
 * stale/unavailable data." The dashboard must never present a failed or
 * unreadable integration as if it were healthy.
 */

export interface StatusInput {
  label: string;
  value: string;
  source: string;
  updatedAt: string | Date | null;
  /** true = read from a real system; false = derived/recommendation */
  confirmed: boolean;
  /** true when the underlying integration could not be read */
  unavailable?: boolean;
  /** max age before the data is considered stale (minutes) */
  staleAfterMinutes?: number;
  now?: Date;
}

const DEFAULT_STALE_MINUTES = 15;

export function makeSourcedStatus(input: StatusInput): SourcedStatus {
  const now = input.now ?? new Date();
  const updatedAt = input.updatedAt ? new Date(input.updatedAt).toISOString() : null;

  let confidence: StatusConfidence;
  if (input.unavailable) {
    confidence = 'unavailable';
  } else if (!input.confirmed) {
    confidence = 'inferred';
  } else if (updatedAt && isStale(updatedAt, input.staleAfterMinutes ?? DEFAULT_STALE_MINUTES, now)) {
    confidence = 'stale';
  } else {
    confidence = 'confirmed';
  }

  return {
    label: input.label,
    value: input.value,
    source: input.source,
    updatedAt,
    confidence,
  };
}

export function isStale(updatedAt: string, staleAfterMinutes: number, now: Date = new Date()): boolean {
  const ageMs = now.getTime() - new Date(updatedAt).getTime();
  return ageMs > staleAfterMinutes * 60_000;
}

export interface WorkItemStatus {
  id: string;
  kind: string;
  title: string;
  updatedAt: string;
  /** Status values that mean the work is progressing (not stale-eligible check). */
  activityStatus: string;
  /** Statuses considered "actively being worked" — these are checked for staleness. */
  activeStatuses: string[];
  dueAt?: string | null;
}

export interface StaleWorkItem extends WorkItemStatus {
  staleReason: string;
  ageMinutes: number;
}

/**
 * Detect stale/overdue work: items that claim to be active but have had no
 * update inside the freshness window, or items past their due date.
 */
export function findStaleWork(items: WorkItemStatus[], staleAfterMinutes: number, now: Date = new Date()): StaleWorkItem[] {
  const out: StaleWorkItem[] = [];
  for (const item of items) {
    const ageMinutes = (now.getTime() - new Date(item.updatedAt).getTime()) / 60_000;
    const isActive = item.activeStatuses.includes(item.activityStatus);
    const overdue = item.dueAt ? new Date(item.dueAt).getTime() < now.getTime() : false;

    if (isActive && ageMinutes > staleAfterMinutes) {
      out.push({ ...item, staleReason: `No update in ${Math.round(ageMinutes)}m while status is "${item.activityStatus}"`, ageMinutes });
    } else if (overdue && !['Completed', 'Cancelled'].includes(item.activityStatus)) {
      out.push({ ...item, staleReason: 'Past due date', ageMinutes });
    }
  }
  return out.sort((a, b) => b.ageMinutes - a.ageMinutes);
}
