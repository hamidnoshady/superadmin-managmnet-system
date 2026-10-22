import type { Task } from './types.js';

/**
 * Discrepancy detection between internal task state and external tracks.
 *
 * Product principle: "Detect stale work and discrepancies between internal
 * task status and GitHub state." Advisory only — surfaced to the operator.
 */

export interface Discrepancy {
  taskId: string;
  taskTitle: string;
  code: string;
  severity: 'high' | 'medium' | 'low';
  message: string;
  internalStatus: string;
  tracks: Record<string, string>;
}

const OPEN_GITHUB = new Set(['open', 'unknown']);

export function findDiscrepancies(tasks: Pick<Task, 'id' | 'title' | 'internalStatus' | 'githubStatus' | 'agentStatus' | 'testStatus' | 'prStatus' | 'deployStatus'>[]): Discrepancy[] {
  const out: Discrepancy[] = [];
  const push = (t: typeof tasks[number], code: string, severity: Discrepancy['severity'], message: string) => {
    out.push({
      taskId: t.id,
      taskTitle: t.title,
      code,
      severity,
      message,
      internalStatus: t.internalStatus,
      tracks: {
        github: t.githubStatus,
        agent: t.agentStatus,
        test: t.testStatus,
        pr: t.prStatus,
        deploy: t.deployStatus,
      },
    });
  };

  for (const t of tasks) {
    // Completed internally while GitHub issue is still open.
    if (t.internalStatus === 'Completed' && OPEN_GITHUB.has(t.githubStatus) && t.githubStatus !== 'unknown') {
      push(t, 'completed-github-open', 'high', 'Task is Completed internally but the GitHub issue is still open — sync or reopen.');
    }

    // GitHub issue closed but work is still active internally.
    if (t.githubStatus === 'closed' && !['Completed', 'Cancelled'].includes(t.internalStatus)) {
      push(t, 'github-closed-internal-active', 'high', 'GitHub issue is closed but internal work is still active — decide which side is right.');
    }

    // Active development with no agent activity.
    if (['In Development', 'Testing', 'Review'].includes(t.internalStatus) && t.agentStatus === 'none') {
      push(t, 'active-no-agent', 'medium', 'Work is active but no agent run is recorded — run state is missing evidence.');
    }

    // Ready for merge with failing tests.
    if (t.internalStatus === 'Ready for Merge' && t.testStatus === 'failing') {
      push(t, 'ready-with-failing-tests', 'high', 'Marked Ready for Merge while tests are failing.');
    }

    // Completed with failing tests.
    if (t.internalStatus === 'Completed' && t.testStatus === 'failing') {
      push(t, 'completed-failing-tests', 'high', 'Completed while tests are failing.');
    }

    // PR merged but task not completed.
    if (t.prStatus === 'merged' && !['Completed', 'Ready for Merge'].includes(t.internalStatus)) {
      push(t, 'pr-merged-task-open', 'medium', 'PR is merged but the task is not Completed — close the loop.');
    }

    // Deployed but task not completed.
    if (t.deployStatus === 'passing' && t.internalStatus !== 'Completed') {
      push(t, 'deployed-task-open', 'low', 'Deployment recorded but the task is not Completed.');
    }
  }

  return out.sort((a, b) => (a.severity === 'high' ? 0 : a.severity === 'medium' ? 1 : 2) - (b.severity === 'high' ? 0 : b.severity === 'medium' ? 1 : 2));
}
