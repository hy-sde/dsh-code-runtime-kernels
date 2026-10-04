/**
 * Stdin pipe-failure hardening (omp #14196/#14199): a write to a dead
 * kernel's stdin must never take the host down — not with an uncaught
 * `write EPIPE` from the stream's 'error' event, and not with an unhandled
 * rejection from a reply racing the kernel's death. A failed write settles
 * the in-flight run as killed, retires the kernel, and the session registry
 * replaces it transparently. Real subprocesses, killed mid-flight.
 */

import { setTimeout as delay } from 'node:timers/promises'
import { describe, expect, it, vi } from 'vitest'
import type { PtcBindingNamespace } from '@deepseek-ai/dsh-ptc-runtime'
import { KernelHost, nodejsKernelProfile } from '../src/core/kernel.ts'
import { KernelManager } from '../src/index.ts'
import { tempSnapshotDir } from './test-util.ts'

/**
 * Capture would-be-fatal process-level errors for the duration of one test:
 * with no other listener, Node escalates a stdin 'error' event or an
 * unhandled rejection to a crash instead of a failed assertion.
 */
function captureFatal(): { collected: string[]; done: () => void } {
  const collected: string[] = []
  const onRejection = (reason: unknown) => { collected.push(`unhandledRejection: ${String(reason)}`) }
  const onException = (error: unknown) => { collected.push(`uncaughtException: ${String(error)}`) }
  process.on('unhandledRejection', onRejection)
  process.on('uncaughtException', onException)
  return {
    collected,
    done: () => {
      process.off('unhandledRejection', onRejection)
      process.off('uncaughtException', onException)
    },
  }
}

function startConfig() {
  return {
    cwd: process.cwd(),
    startupTimeoutMs: 15_000,
    interruptEscalationMs: 5_000,
    shutdownGraceMs: 1_000,
  }
}

function kernelPid(kernel: KernelHost): number {
  const pid = kernel.pid
  if (pid === undefined) throw new Error('kernel has no pid')
  return pid
}

/**
 * A stand-in runner that completes the bootstrap handshake, then closes its
 * own end of the stdin pipe while staying alive — so a host write fails with
 * EPIPE against a kernel the host still considers healthy (the pure
 * write-failure path, without a process-death race). Closing the stream via
 * the API is a no-op for a never-read pipe; the fd must actually be closed.
 */
const CLOSED_STDIN_RUNNER = `
process.stdout.write(JSON.stringify({ type: 'ready', pid: process.pid }) + '\\n')
import('node:fs').then((fs) => { fs.closeSync(0) })
setInterval(() => {}, 1_000)
`

describe('KernelHost — stdin pipe failures (omp #14196/#14199)', () => {
  it('settles a run killed when its exec write fails mid-flight, without crashing the host', { timeout: 30_000 }, async () => {
    const kernel = await KernelHost.start(nodejsKernelProfile(process.execPath), startConfig())
    const fatal = captureFatal()
    try {
      // A payload far beyond the pipe buffer keeps the exec write pending;
      // the SIGKILL lands while it is still in flight, so the write fails
      // (EPIPE, or ERR_STREAM_DESTROYED if the parent notices the death
      // first) instead of completing. Either way the run must settle as
      // killed — never hang, never throw, never crash the host.
      const code = `const blob = ${JSON.stringify('x'.repeat(8 * 1024 * 1024))}\nblob.length`
      const pending = kernel.execute('dead-pipe', code, [], {})
      process.kill(kernelPid(kernel), 'SIGKILL')
      const result = await pending
      expect(result.status).toBe('error')
      expect(result.killed).toBe(true)
      // One macrotask turn: a host-killing stdin 'error' event or unhandled
      // reply rejection would have landed by now and been captured above.
      await delay(50)
      expect(fatal.collected).toEqual([])
      // The kernel retired itself: a follow-up execute is answered, not hung.
      const after = await kernel.execute('after-death', '1 + 1', [], {})
      expect(after.status).toBe('error')
      expect(after.killed).toBe(true)
    } finally {
      fatal.done()
      await kernel.shutdown()
    }
  })

  it('answers — not hangs, not throws — an execute against an already-dead kernel', { timeout: 30_000 }, async () => {
    const kernel = await KernelHost.start(nodejsKernelProfile(process.execPath), startConfig())
    const fatal = captureFatal()
    try {
      process.kill(kernelPid(kernel), 'SIGKILL')
      await vi.waitFor(() => { expect(kernel.isAlive()).toBe(false) })
      const result = await kernel.execute('dead', '1 + 1', [], {})
      expect(result.status).toBe('error')
      expect(result.killed).toBe(true)
      expect(result.message).toContain('is not running')
      await delay(50)
      expect(fatal.collected).toEqual([])
    } finally {
      fatal.done()
      await kernel.shutdown()
    }
  })

  it('settles the run and retires the kernel when a write fails on an otherwise-live kernel', { timeout: 30_000 }, async () => {
    const kernel = await KernelHost.start({
      ...nodejsKernelProfile(process.execPath),
      stagedSource: CLOSED_STDIN_RUNNER,
    }, startConfig())
    const fatal = captureFatal()
    try {
      // By now the runner has closed its read end while the process itself
      // is still alive: the exec write fails with EPIPE and the run must
      // settle killed instead of hanging forever.
      await delay(400)
      const result = await kernel.execute('closed-stdin', '1 + 1', [], {})
      expect(result.status).toBe('error')
      expect(result.cancelled).toBe(true)
      expect(result.killed).toBe(true)
      expect(result.message).toContain('stdin write failed')
      // The kernel retired itself through the shutdown ladder.
      await vi.waitFor(() => { expect(kernel.isAlive()).toBe(false) })
      await delay(50)
      expect(fatal.collected).toEqual([])
      await kernel.shutdown()
    } finally {
      fatal.done()
    }
  })

  it('replaces a pipe-failed kernel and the retried session run succeeds', { timeout: 60_000, skip: process.platform === 'win32' }, async () => {
    // The binding kills the caller's own process group mid-call (the kernel
    // is a session leader via setsid, so -pid is exactly its group): the
    // reply write then races the kernel's death and must fail harmlessly —
    // no unhandled rejection, the run settles killed, and the session
    // registry's replace-and-retry recovery re-runs the program on a fresh
    // kernel where the same binding hits the no-op branch.
    let kills = 0
    const bindings: PtcBindingNamespace[] = [{
      global: 'test',
      functions: {
        dieOnce: async (args: unknown) => {
          const { pid } = args as { pid: number }
          if (kills++ === 0) process.kill(-pid, 'SIGKILL')
          return null
        },
      },
    }]
    const fatal = captureFatal()
    const manager = new KernelManager({
      languages: ['typescript'],
      snapshotDir: tempSnapshotDir(),
    })
    try {
      const result = await manager.run({
        language: 'typescript',
        sessionId: 'pipe-recovery',
        code: 'await test.dieOnce({ pid: process.pid })\nreturn 42',
        bindings,
      })
      expect(result.error).toBeUndefined()
      expect(result.value).toBe(42)
      // The retried run executed on a REPLACED kernel: a fresh session's
      // execution count, not the killed kernel's.
      expect(result.executionCount).toBe(1)
      await delay(50)
      expect(fatal.collected).toEqual([])
    } finally {
      fatal.done()
      await manager.teardown()
    }
  })
})
