/**
 * The Python kernel gives user code /dev/null as stdin (omp b6a8c46935): the
 * runner's own stdin is the host's NDJSON control channel that never closes,
 * so user code — and every process it spawns without an explicit stdin —
 * used to block on it forever (a hung `input()`) or steal frames meant for
 * the runner. Requests now arrive on a private dup of the original stdin and
 * fd 0 itself is repointed at os.devnull, mirroring the fd-1 frame capture.
 * Real subprocesses, through the session manager.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { KernelManager } from '../src/index.ts'
import { cleanTempSnapshotDirs, tempSnapshotDir } from './test-util.ts'

function makeManager(): KernelManager {
  return new KernelManager({
    languages: ['python'],
    snapshotDir: tempSnapshotDir(),
    // Bounds a regression (a stdin read that blocks on the control channel)
    // as a timeout failure instead of a hung suite; the pass path is instant.
    maxWallMs: 15_000,
  })
}

async function withManager(fn: (manager: KernelManager) => Promise<void>): Promise<void> {
  const manager = makeManager()
  try {
    await fn(manager)
  } finally {
    await manager.teardown()
  }
}

describe('python kernel — stdin is /dev/null (omp b6a8c46935)', () => {
  afterEach(() => {
    cleanTempSnapshotDirs()
  })

  it('gives a child spawned by user code EOF on stdin instead of the control channel', { timeout: 30_000 }, async () => {
    await withManager(async (manager) => {
      // Without an explicit stdin, a child inherits the runner's fd 0. That
      // must not be the host's control pipe, which stays open for the
      // kernel's whole life: a stdin-reading child would block until its own
      // timeout, or steal requests meant for the runner.
      const child = "import sys; print('read=' + repr(sys.stdin.read()))"
      const code = [
        'import subprocess, sys',
        `proc = subprocess.run([sys.executable, "-c", ${JSON.stringify(child)}], capture_output=True, text=True, timeout=10)`,
        "print(proc.stdout, end='')",
      ].join('\n')
      const first = await manager.run({ language: 'python', sessionId: 'stdin-child', code })
      expect(first.error).toBeUndefined()
      expect(first.logs.join('')).toContain("read=''")
      // The control channel survived the child: a follow-up run is served,
      // not stolen by the reader that blocked above.
      const second = await manager.run({
        language: 'python',
        sessionId: 'stdin-child',
        code: "print('second request served')",
      })
      expect(second.error).toBeUndefined()
      expect(second.logs.join('')).toContain('second request served')
    })
  })

  it('reads immediate EOF when user code itself reads stdin', { timeout: 30_000 }, async () => {
    await withManager(async (manager) => {
      const result = await manager.run({
        language: 'python',
        sessionId: 'stdin-user',
        code: "import sys\nprint('read=' + repr(sys.stdin.read()))",
      })
      expect(result.error).toBeUndefined()
      expect(result.logs.join('')).toContain("read=''")
    })
  })
})
