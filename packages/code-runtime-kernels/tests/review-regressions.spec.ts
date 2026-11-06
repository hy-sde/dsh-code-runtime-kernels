/**
 * Regression coverage for the kernel review findings (kernel-review.md):
 * each test pins one reviewed behavior — combined output budgets, idle-queue
 * drain, already-aborted admissions, structured spawn failures, DSH env
 * scrubbing, cancelled-cell ghost retirement, snapshot persistence status
 * surfacing, truthfulness of the TypeScript surface, and per-conversation
 * session identity at the tool layer. Real subprocesses throughout.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { Context } from '@deepseek-ai/cordis'
import type { KernelSandboxProvider } from '../src/core/kernel.ts'
import * as Kernels from '../src/index.ts'
import { cleanTempSnapshotDirs, tempSnapshotDir } from './test-util.ts'

afterEach(() => { cleanTempSnapshotDirs() })

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
      // Run 1 executes longer than the idle window while run 2 waits queued,
      // and run 2 ITSELF outlives the window: the old code armed run 2's idle
      // deadline when run 1's admission settled, so a quick run 2 finished
      // before the timer fired and the test could not fail pre-fix. With run 2
      // sleeping 0.4s the stale 250ms deadline would kill it mid-execution;
      // the deadline may only fire at queue drain now.
      const first = manager.run({
        language: 'python',
        sessionId,
        code: "import time\ntime.sleep(0.6)\n'first'",
      })
      const second = manager.run({
        language: 'python',
        sessionId,
        code: "import time\ntime.sleep(0.4)\n'second'",
      })
      const [one, two] = await Promise.all([first, second])
      expect(one.error).toBeUndefined()
      expect(one.value).toBe('first')
      expect(two.error).toBeUndefined()
      expect(two.value).toBe('second')
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

  it('scrubs harness and credential environment entries while keeping deliberate kernel env', async () => {
    process.env.DSH_PROBE_MARKER = 'must-not-leak'
    process.env.DEEPSEEK_API_KEY = 'credential-must-not-leak'
    try {
      await withManager(async (manager) => {
        const scrubbed = await manager.run({
          language: 'python',
          code: "dict(dsh=__import__('os').environ.get('DSH_PROBE_MARKER'), key=__import__('os').environ.get('DEEPSEEK_API_KEY'))",
        })
        expect(scrubbed.value).toEqual({ dsh: null, key: null })
        const deliberate = await manager.run({
          language: 'python',
          code: "type(__import__('os').environ.get('DSH_KERNEL_CWD')).__name__",
        })
        expect(deliberate.value).toBe('str')
      })
    } finally {
      delete process.env.DSH_PROBE_MARKER
      delete process.env.DEEPSEEK_API_KEY
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

describe('review regressions — teardown ownership', () => {
  it('aborts a child that is still waiting for its startup handshake', async () => {
    const pidFile = join(tempSnapshotDir(), 'startup.pid')
    const childSource = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`
    const provider: KernelSandboxProvider = {
      async confine() {
        return { argv: [process.execPath, '-e', childSource] }
      },
    }
    const manager = makeManager({
      sandboxConfinement: true,
      sandboxProvider: provider,
      snapshot: false,
      startupTimeoutMs: 60_000,
      shutdownGraceMs: 20,
    })
    try {
      const run = manager.run({
        language: 'typescript',
        sessionId: 'startup-teardown',
        code: 'return 1',
      })
      const settled = run.catch(error => error)
      await expect.poll(() => existsSync(pidFile), { timeout: 5_000 }).toBe(true)
      const pid = Number(readFileSync(pidFile, 'utf8'))
      await expect(manager.teardown()).resolves.toBeUndefined()
      expect(await settled).toMatchObject({ error: { kind: 'abort' } })
      expect(() => process.kill(pid, 0)).toThrow()
    } finally {
      await manager.teardown()
    }
  })

  it('aborts and drains an executing one-shot before teardown resolves', async () => {
    const entered = Promise.withResolvers<void>()
    const manager = makeManager({ interruptEscalationMs: 20, shutdownGraceMs: 20 })
    try {
      const run = manager.run({
        language: 'typescript',
        code: 'await probe.started({}); await new Promise(() => {})',
        bindings: [{
          global: 'probe',
          functions: {
            started: async () => {
              entered.resolve()
              return true
            },
          },
        }],
      })
      await entered.promise
      const teardown = manager.teardown()
      const result = await run
      await expect(teardown).resolves.toBeUndefined()
      expect(result.error?.kind).toBe('abort')
    } finally {
      await manager.teardown()
    }
  })
})

describe('review regressions — execution context ownership', () => {
  it('runs preload and user cells in the same requested working directory', async () => {
    const cwd = tempSnapshotDir()
    await withManager(async (manager) => {
      const result = await manager.run({
        language: 'typescript',
        sessionId: 'preload-cwd',
        cwd,
        code: 'return { preload: state.preloadCwd, current: process.cwd() }',
      })
      expect(result.error).toBeUndefined()
      expect(result.value).toEqual({ preload: realpathSync(cwd), current: realpathSync(cwd) })
    }, { preload: { typescript: 'state.preloadCwd = process.cwd()' } })
  })

  it('passes only the owning DSH session to sandbox policy', async () => {
    const observed: Array<SessionId | undefined> = []
    const provider: KernelSandboxProvider = {
      async confine(argv, policy) {
        observed.push(policy.sessionId)
        return { argv: [...argv] }
      },
    }
    const owner = SessionId('owner-a')
    await withManager(async (manager) => {
      const result = await manager.run({
        language: 'typescript',
        sessionId: 'owner-a:analysis',
        sandboxSessionId: owner,
        code: 'return 1',
      })
      expect(result.error).toBeUndefined()
    }, { sandboxConfinement: true, sandboxProvider: provider, snapshot: false })
    expect(observed).toEqual([owner])
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

  it('runs already-queued siblings after a mid-queue kernel death instead of invalidating them', async () => {
    await withManager(async (manager) => {
      const sessionId = 'queue-death'
      // Two admissions race on one session; the executing kernel dies under
      // the first run. The old fix retired the session by DELETING the
      // registry entry, which made the queued sibling reject with "session
      // invalidated while acquiring kernel" without ever executing. The
      // retirement must keep the entry (chain + pending count intact) and
      // only drop the kernel.
      const first = manager.run({ language: 'python', sessionId, code: 'import os\nos._exit(137)' })
      const second = manager.run({ language: 'python', sessionId, code: "'sibling-ran'" })
      const [one, two] = await Promise.all([first, second])
      expect(one.error?.kind).toBe('worker-exit')
      expect(two.error).toBeUndefined()
      expect(two.value).toBe('sibling-ran')
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

describe('review regressions — output accounting', () => {
  it('reports a single oversized frame as output-limit and labels its spill as partial', async () => {
    const captures: Array<Kernels.OutputLimitInfo & { content: string }> = []
    await withManager(async (manager) => {
      const result = await manager.run({
        language: 'python',
        code: "print('z' * 3000)",
      }, async (content, info) => {
        captures.push({ content, ...info })
        return 'spill://kernel-output-prefix'
      })
      expect(result.error?.kind).toBe('output-limit')
      expect(result.error?.message).toContain('discarded tail unavailable')
      expect(captures).toHaveLength(1)
      expect(captures[0]?.complete).toBe(false)
      expect(captures[0]?.content).toContain('z'.repeat(512))
    }, { maxOutputBytes: 1024 })
  })

  it('never returns a completion value alongside an output-limit failure', async () => {
    await withManager(async (manager) => {
      const result = await manager.run({
        language: 'typescript',
        code: "console.log('small'); return 'v'.repeat(300)",
      })
      expect(result.error?.kind).toBe('output-limit')
      expect(result.value).toBeUndefined()
    }, { maxOutputBytes: 128 })
  })

  it('preserves an ordinary diagnostic that fits the configured budget', async () => {
    await withManager(async (manager) => {
      const result = await manager.run({
        language: 'python',
        code: "raise ValueError('diagnostic-' + 'e' * 200)",
      })
      expect(result.error?.kind).toBe('exception')
      expect(result.error?.message).toContain(`diagnostic-${'e'.repeat(200)}`)
    }, { maxOutputBytes: 512 })
  })
})

describe('review regressions — TypeScript truthfulness (finding 7)', () => {
  it('strips erasable type annotations and resolves dynamic imports', async () => {
    await withManager(async (manager) => {
      const result = await manager.run({
        language: 'typescript',
        // Bare builtins (no `node:` prefix) must resolve too — require.resolve
        // would turn them into a bogus file path under the run directory.
        code: "const n: number = 41\nconst fs = await import('node:fs')\nconst p = await import('path')\nreturn { n, t: typeof fs.readFileSync, j: typeof p.join }",
      })
      expect(result.error).toBeUndefined()
      expect(result.value).toEqual({ n: 41, t: 'function', j: 'function' })
    })
  })

  it('uses native ESM conditions, import attributes, package imports, and absolute paths', async () => {
    const cwd = tempSnapshotDir()
    const packageDir = join(cwd, 'node_modules', 'import-only-fixture')
    mkdirSync(packageDir, { recursive: true })
    writeFileSync(join(packageDir, 'package.json'), JSON.stringify({
      name: 'import-only-fixture',
      type: 'module',
      exports: { import: './index.mjs' },
    }))
    writeFileSync(join(packageDir, 'index.mjs'), 'export const packageValue = 41\n')
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({
      type: 'module',
      imports: { '#local-fixture': './local.mjs' },
    }))
    writeFileSync(join(cwd, 'local.mjs'), 'export const localValue = 42\n')
    writeFileSync(join(cwd, 'absolute.mjs'), 'export const absoluteValue = 43\n')
    writeFileSync(join(cwd, 'value.json'), '{"jsonValue":44}\n')

    await withManager(async (manager) => {
      const absolutePath = join(cwd, 'absolute.mjs')
      const result = await manager.run({
        language: 'typescript',
        cwd,
        code: [
          "const pkg = await import('import-only-fixture')",
          "const local = await import('#local-fixture')",
          `const absolute = await import(${JSON.stringify(absolutePath)})`,
          "const json = await import('./value.json', { with: { type: 'json' } })",
          'return { packageValue: pkg.packageValue, localValue: local.localValue, absoluteValue: absolute.absoluteValue, jsonValue: json.default.jsonValue }',
        ].join('\n'),
      })
      expect(result.error).toBeUndefined()
      expect(result.value).toEqual({ packageValue: 41, localValue: 42, absoluteValue: 43, jsonValue: 44 })
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
    await ctx.plugin(NativeToolExecutor)
    const fiber = ctx.plugin(Kernels, { languages: ['python', 'typescript'], snapshotDir: tempSnapshotDir() })
    try {
      const call = async (name: string, args: unknown, conversation: string) => {
        // 0.2.2 dispatches whole model batches; unwrap the single result.
        const batch = await ctx.tools.execute({
          calls: [{ type: 'tool-call' as const, id: ToolCallId(`rr-${conversation}-${Math.random().toString(36).slice(2, 7)}`), name, arguments: JSON.stringify(args)}],
          signal: new AbortController().signal,
          agent: { session: { header: { id: conversation, cwd: process.cwd() } } } as never,
        })
        return batch.results[0]!.result
      }
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

  it('surfaces working-directory resolution failures instead of running in host cwd', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime, {})
    await ctx.plugin(NativeToolExecutor)
    ctx.provide('workingDirectory' as never, {
      ensure: async () => {
        throw new Error('workspace is unavailable')
      },
    } as never)
    const fiber = ctx.plugin(Kernels, { languages: ['python'], snapshotDir: tempSnapshotDir() })
    try {
      const batch = await ctx.tools.execute({
        calls: [{ type: 'tool-call' as const, id: ToolCallId('rr-working-directory-failure'), name: 'run_kernel_code', arguments: JSON.stringify({ language: 'python', code: '1 + 1' }) }],
        signal: new AbortController().signal,
        agent: { session: { header: { id: 'cwd-failure', cwd: process.cwd() } } } as never,
      })
      const result = batch.results[0]!.result
      expect(result.isError).toBe(true)
      const text = result.content.filter(block => block.type === 'text').map(block => block.text).join('')
      expect(text).toContain('workspace is unavailable')
    } finally {
      await fiber.dispose()
      cleanTempSnapshotDirs()
    }
  })
})
