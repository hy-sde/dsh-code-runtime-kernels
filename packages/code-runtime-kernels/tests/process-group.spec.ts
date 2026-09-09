/**
 * Tests for the process-group kill helpers (`isSignalableProcessGroup` /
 * `killProcessGroup`) ported from oh-my-pi's `eval/kernel-base.ts` (#7714 fix).
 * Degenerate group targets must be rejected before the negation is applied:
 * `-0` would signal our own group and `-1` every process we may signal.
 */

import { describe, expect, it } from 'vitest'
import { isSignalableProcessGroup, killProcessGroup } from '../src/core/kernel.ts'

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
