/**
 * Shared test utilities: per-test temporary snapshot directories so snapshot
 * tests exercise real persistence without writing into the developer's home
 * directory, plus one-shot cleanup.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const created: string[] = []

/** A fresh, unique snapshot root for one test/manager. */
export function tempSnapshotDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-kernels-test-'))
  created.push(dir)
  return dir
}

/** Remove every directory {@link tempSnapshotDir} created (idempotent). */
export function cleanTempSnapshotDirs(): void {
  for (const dir of created.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // Best-effort: a locked leftover in the OS temp dir is not a test failure.
    }
  }
}
