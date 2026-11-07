import fs from 'node:fs';

/**
 * Windows-safe temp cleanup.
 *
 * On Windows, `fs.rmSync` fails with EBUSY while background git processes
 * spawned by a still-finishing run briefly lock files in the temp repo
 * (Linux ignores such handles). Retry for a short window, then leave any
 * residue in the OS temp dir rather than failing the suite.
 */
export async function removeTempDir(dir: string, attempts = 8): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // Residue stays in the OS temp dir — never fail the suite over cleanup.
  }
}
