/**
 * Tests for the process-group kill helpers (`isSignalableProcessGroup` /
 * `killProcessGroup`) ported from oh-my-pi's `eval/kernel-base.ts` (#7714 fix).
 * Degenerate group targets must be rejected before the negation is applied:
 * `-0` would signal our own group and `-1` every process we may signal.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isSignalableProcessGroup, killProcessGroup } from '../src/core/kernel.ts'
import { KernelManager } from '../src/index.ts'

describe('isSignalableProcessGroup', () => {
  it('accepts ordinary positive pids', () => {
    expect(isSignalableProcessGroup(2)).toBe(true)
    expect(isSignalableProcessGroup(12345)).toBe(true)
  })

  it('rejects degenerate and non-pid targets', () => {
    // 0 / 1: `-0` is our own group, `-1` is every signalable process.
    expect(isSignalableProcessGroup(0)).toBe(false)
    expect(isSignalableProcessGroup(1)).toBe(false)
    expect(isSignalableProcessGroup(undefined)).toBe(false)
    expect(isSignalableProcessGroup(-5)).toBe(false)
    expect(isSignalableProcessGroup(1.5)).toBe(false)
    expect(isSignalableProcessGroup(Number.NaN)).toBe(false)
  })
})

describe('killProcessGroup', () => {
  it('is a no-op for a target it must never signal', () => {
    // The degenerate cases never reach process.kill(-pid) — the function
    // returns false without a throw, so a shutdown sweeping an absent kernel
    // cannot escalate into signalling the host's own group.
    expect(killProcessGroup(0, 'SIGKILL')).toBe(false)
    expect(killProcessGroup(1, 'SIGKILL')).toBe(false)
    expect(killProcessGroup(undefined, 'SIGKILL')).toBe(false)
  })

  it('signals a real temporary process group on POSIX', async () => {
    // POSIX-only: Windows has no process groups. Spawn a detached child that
    // becomes a session/group leader (setsid via detached), then sweep the
    // whole group it leads and observe the child dies from the group signal.
    if (process.platform === 'win32') return
    const { spawn } = await import('node:child_process')
    const proc = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true,
      stdio: 'ignore',
    })
    expect(proc.pid).toBeDefined()
    const pid = proc.pid as number
    proc.unref()
    try {
      // The child is alive before the sweep.
      expect(isSignalableProcessGroup(pid)).toBe(true)
      // Group-kill it with SIGTERM; the child ignores nothing so it exits.
      expect(killProcessGroup(pid, 'SIGTERM')).toBe(true)
    } finally {
      // Belt and braces: nothing may outlive the test.
      try { process.kill(-pid, 'SIGKILL') } catch { /* gone */ }
      try { process.kill(pid, 'SIGKILL') } catch { /* gone */ }
    }
  })
})

describe('KernelHost shutdown — process-group sweep', () => {
  // POSIX-only: Windows has no process groups and the runner is not detached.
  it('sweeps TERM-resistant descendants even after a graceful leader exit', async () => {
    if (process.platform === 'win32') return
    // A temporary pidfile: the python program and this test must agree on a
    // path that does not collide across parallel spec processes.
    const dir = mkdtempSync(join(tmpdir(), 'dsh-kernel-pg-'))
    const pidFile = join(dir, 'child.pid')
    let manager: KernelManager | undefined
    try {
      manager = new KernelManager({ languages: ['python'], shutdownGraceMs: 250 })
      // The python kernel's runner is detached (setsid), so this program's
      // spawned child lands in the kernel's process group. The child installs
      // a TERM trap to survive the graceful part of the shutdown; only the
      // final group SIGKILL sweep (omp c5aa69d322) can reap it. The program
      // writes the child's pid so the test can assert on it directly. A
      // sessionId keeps the kernel alive past the run so `teardown()` drives
      // the shutdown under test.
      const result = await manager.run({
        language: 'python',
        sessionId: 'sweep',
        code: [
          'import subprocess',
          "child = subprocess.Popen(['sh', '-c', 'trap \"\" TERM; exec sleep 30'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)",
          `open(${JSON.stringify(pidFile)}, 'w').write(str(child.pid))`,
          "'ok'",
        ].join('\n'),
      })
      expect(result.error).toBeUndefined()
      const childPid = Number(readFileSync(pidFile, 'utf8').trim())
      expect(childPid).toBeGreaterThan(0)
      // Teardown drives kernel.shutdown(): the `exit` frame makes the python
      // runner exit gracefully (the leader honors it), while its spawned child
      // keeps ignoring TERM. The NEW code then unconditionally SIGKILL-sweeps
      // the group; the OLD code returned early and left the child alive.
      await manager.teardown()
      manager = undefined
      // The group SIGKILL reaps the child: process.kill(pid, 0) must go ESRCH
      // (or the pid becomes a zombie reaped by init — either way no live
      // process may hold it). Poll up to 1s for the sweep to land.
      let dead = false
      const deadline = Date.now() + 1_000
      while (Date.now() < deadline) {
        try {
          process.kill(childPid, 0)
        } catch (error: unknown) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') { dead = true; break }
        }
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      expect(dead).toBe(true)
    } finally {
      if (manager !== undefined) await manager.teardown().catch(() => {})
      // Guarantee cleanup: nothing spawned by this test may outlive it.
      if (existsSync(pidFile)) {
        const doomed = Number(readFileSync(pidFile, 'utf8').trim())
        if (Number.isInteger(doomed) && doomed > 0) {
          try { process.kill(doomed, 'SIGKILL') } catch { /* gone */ }
        }
      }
      try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
    }
  })
})
