/**
 * Regression coverage for the kernel review findings (kernel-review.md):
 * each test pins one reviewed behavior — combined output budgets, idle-queue
 * drain, already-aborted admissions, structured spawn failures, DSH env
 * scrubbing, cancelled-cell ghost retirement, snapshot persistence status
 * surfacing, truthfulness of the TypeScript surface, and per-conversation
 * session identity at the tool layer. Real subprocesses throughout.
 */

import { chmodSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { describe, expect, it } from 'vitest'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { Context } from '@deepseek-ai/cordis'
import * as Kernels from '../src/index.ts'
import { cleanTempSnapshotDirs, tempSnapshotDir } from './test-util.ts'

function makeManager(overrides: Record<string, unknown> = {}): Kernels.KernelManager {
  return new Kernels.KernelManager({
    languages: ['python', 'typescript'],
    snapshotDir: tempSnapshotDir(),
    ...overrides,
  })
}

async function withManager<T>(
  fn: (manager: Kernels.KernelManager) => Promise<T>,
  overrides: Record<string, unknown> = {},
): Promise<T> {
  const manager = makeManager(overrides)
  try {
    return await fn(manager)
  } finally {
    await manager.teardown()
  }
}

describe('review regressions — output budget (finding 5)', () => {
  it('counts captured logs toward maxOutputBytes even when no value is returned', async () => {
    await withManager(async (manager) => {
      // A log-heavy program with NO completion value: before the fix the
      // ledger only budgeted the completion value, so this returned success.
      const result = await manager.run({ language: 'python', code: "print('y' * 500)" })
      expect(result.error?.kind).toBe('output-limit')
    }, { maxOutputBytes: 64 })
  })
})

describe('review regressions — idle scheduling (finding 6)', () => {
  it('never reaps a session whose queue still holds pending runs', async () => {
    await withManager(async (manager) => {
      const sessionId = 'idle-queue'
      // Run 1 executes longer than the idle window while run 2 waits queued.
      // The old code armed run 2's idle deadline when run 1's admission
      // settled, killing run 2 mid-execution; the deadline may only fire at
      // queue drain now.
      const first = manager.run({
        language: 'python',
        sessionId,
        code: "import time\ntime.sleep(0.6)\n'first'",
      })
      const second = manager.run({
        language: 'python',
        sessionId,
        code: '2 + 2',
      })
      const [one, two] = await Promise.all([first, second])
      expect(one.error).toBeUndefined()
      expect(one.value).toBe('first')
      expect(two.error).toBeUndefined()
      expect(two.value).toBe(4)
      // After the queue drains the idle deadline is live again: a later run
      // still works (fresh or reaped kernel alike).
      const third = await manager.run({ language: 'python', sessionId, code: '3 + 3' })
      expect(third.error).toBeUndefined()
      expect(third.value).toBe(6)
    }, { sessionIdleMs: 250 })
  })

  it('answers an already-aborted signal with an abort before any kernel work', async () => {
    await withManager(async (manager) => {
      const controller = new AbortController()
      controller.abort(new Error('gave up before admission'))
      const result = await manager.run({
        language: 'python',
        sessionId: 'pre-aborted',
        code: '1 + 1',
        signal: controller.signal,
      })
      expect(result.error?.kind).toBe('abort')
      expect(result.value).toBeUndefined()
    })
  })
})

describe('review regressions — process surface (finding 4)', () => {
  it('rejects a spawn failure structurally instead of crashing the host', async () => {
    const manager = makeManager({ nodePath: '/nonexistent/dsh-node-binary' })
    try {
      await expect(manager.run({
        language: 'typescript',
        code: 'return 1',
      })).rejects.toThrow(/failed to spawn/)
      // Disposal completes (the failed start leaves no hung exited-promise).
      await expect(manager.teardown()).resolves.toBeUndefined()
    } finally {
      await manager.teardown().catch(() => {})
    }
  })

  it('scrubs DSH_* environment entries and keeps deliberate kernel env', async () => {
    process.env.DSH_PROBE_MARKER = 'must-not-leak'
    try {
      await withManager(async (manager) => {
        const scrubbed = await manager.run({
          language: 'python',
          code: "__import__('os').environ.get('DSH_PROBE_MARKER')",
        })
        expect(scrubbed.value).toBeNull()
        const deliberate = await manager.run({
          language: 'python',
          code: "type(__import__('os').environ.get('DSH_KERNEL_CWD')).__name__",
        })
        expect(deliberate.value).toBe('str')
      })
    } finally {
      delete process.env.DSH_PROBE_MARKER
    }
  })
})

describe('review regressions — cancellation ghost (finding 2)', () => {
  it('retires the JS kernel on caller cancel so ghost state is never visible', async () => {
    await withManager(async (manager) => {
      const controller = new AbortController()
      const pending = manager.run({
        language: 'typescript',
        sessionId: 'ghost',
        code: "state.g = 'set'\nawait new Promise(resolve => setTimeout(resolve, 4000))\nstate.after = 'ghost survived'",
        signal: controller.signal,
      })
      await delay(300)
      controller.abort(new Error('caller gave up'))
      const result = await pending
      expect(result.error?.kind).toBe('abort')
      // The retired kernel carried the still-evaluating ghost; the next run
      // must start on a fresh kernel that never saw the ghost's mutation.
      const next = await manager.run({
        language: 'typescript',
        sessionId: 'ghost',
        code: "return state.g ?? 'gone'",
      })
      expect(next.value).toBe('gone')
    })
  })
})

describe('review regressions — snapshot persistence status (finding 8)', () => {
  it('reports saved, then restored counts across a kernel death', async () => {
    await withManager(async (manager) => {
      const sessionId = 'persistence-lifecycle'
      const seed = await manager.run({ language: 'python', sessionId, code: 'sv = 7' })
      expect(seed.error).toBeUndefined()
      expect(seed.persistence?.saved).toBeGreaterThanOrEqual(1)
      expect(seed.persistence?.saveError).toBeUndefined()
      // Kill the kernel mid-run: the session is retired, and the next
      // invocation restores the snapshot into a fresh kernel.
      const dead = await manager.run({ language: 'python', sessionId, code: 'import os\nos._exit(137)' })
      expect(dead.error?.kind).toBe('worker-exit')
      const revived = await manager.run({ language: 'python', sessionId, code: 'sv' })
      expect(revived.error).toBeUndefined()
      expect(revived.value).toBe(7)
      expect(revived.persistence?.restored).toBeGreaterThanOrEqual(1)
      expect(revived.persistence?.restoreLost).toEqual([])
    })
  })

  it('surfaces a snapshot save failure instead of suppressing it', async () => {
    // Running as root ignores directory write bits — skip there.
    if (typeof process.getuid === 'function' && process.getuid() === 0) return
    const snapshotDir = tempSnapshotDir()
    const manager = makeManager({ snapshotDir })
    try {
      chmodSync(snapshotDir, 0o555)
      const result = await manager.run({ language: 'python', sessionId: 'ro-snap', code: 'a = 1' })
      expect(result.error).toBeUndefined() // the run itself still succeeds
      expect(result.persistence?.saveError).toBeTruthy()
    } finally {
      chmodSync(snapshotDir, 0o755)
      await manager.teardown()
    }
  })
})

describe('review regressions — TypeScript truthfulness (finding 7)', () => {
  it('strips erasable type annotations and resolves dynamic imports', async () => {
    await withManager(async (manager) => {
      const result = await manager.run({
        language: 'typescript',
        code: "const n: number = 41\nconst fs = await import('node:fs')\nreturn { n, t: typeof fs.readFileSync }",
      })
      expect(result.error).toBeUndefined()
      expect(result.value).toEqual({ n: 41, t: 'function' })
    })
  })

  it('rejects non-erasable TypeScript constructs', async () => {
    await withManager(async (manager) => {
      const result = await manager.run({
        language: 'typescript',
        code: 'enum Color { Red }\nreturn Color.Red',
      })
      expect(result.error?.kind).toBe('exception')
    })
  })
})

describe('review regressions — per-conversation session identity (finding 1)', () => {
  it('keeps same-named sessions of different conversations apart at the tool layer', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime, {})
    const fiber = ctx.plugin(Kernels, { languages: ['python', 'typescript'], snapshotDir: tempSnapshotDir() })
    try {
      const call = (name: string, args: unknown, conversation: string) => ctx.tools.execute({
        signal: new AbortController().signal,
        callId: ToolCallId(`rr-${conversation}-${Math.random().toString(36).slice(2, 7)}`),
        name,
        arguments: args,
        agent: { session: { header: { id: conversation, cwd: process.cwd() } } } as never,
      })
      const seed = await call('run_kernel_code', { language: 'python', code: 'shared = 99', session: 'shared' }, 'conv-a')
      expect(seed.isError).toBe(false)
      // The same session NAME in another conversation is a different kernel.
      const other = await call('run_kernel_code', { language: 'python', code: 'shared', session: 'shared' }, 'conv-b')
      const text = other.content.filter(block => block.type === 'text').map(block => block.text).join('')
      expect(text).toContain('exception')
      // ...while the original conversation still sees its own state.
      const mine = await call('run_kernel_code', { language: 'python', code: 'shared', session: 'shared' }, 'conv-a')
      expect(mine.isError).toBe(false)
      const mineText = mine.content.filter(block => block.type === 'text').map(block => block.text).join('')
      expect(mineText).toContain('value: 99')
    } finally {
      await fiber.dispose()
      cleanTempSnapshotDirs()
    }
  })
})
