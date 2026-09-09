/**
 * Tool-surface tests for `@hy-sde-org/dsh-code-runtime-kernels`: a REAL Cordis
 * context with the REAL tool runtime, mounting this plugin's `apply` exactly
 * like a deployment row would, then executing the registered `run_kernel_code`
 * through `ctx.tools.execute()` (the same dispatch model the model faces).
 * Plus pure unit tests for the hostile-peer frame parser and the
 * presentation/meta projectors.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanTempSnapshotDirs, tempSnapshotDir } from './test-util.ts'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import {
  doneFailure,
  parseKernelFrame,
  type KernelFrame,
} from '../src/core/kernel.ts'
import {
  presentRunKernelCodeCall,
  presentRunKernelCodeResult,
  runKernelCodeMeta,
} from '../src/index.ts'
import * as Kernels from '../src/index.ts'

const testToolSignal = new AbortController().signal
let callCounter = 0

function call(name: string, args: unknown) {
  return ctx.tools.execute({
    signal: testToolSignal,
    callId: ToolCallId(`it-${++callCounter}`),
    name,
    arguments: args,
    agent: { session: { header: { id: 'sess-tool', cwd: process.cwd() } } } as never,
  })
}

let ctx: Context
let kernelsFiber: ReturnType<Context['plugin']>

describe('hostile-peer frame parser', () => {
  it('builds exact typed frames from well-formed wire lines', () => {
    const ready = parseKernelFrame({ type: 'ready', pid: 42 }) as Extract<KernelFrame, { type: 'ready' }>
    expect(ready.pid).toBe(42)
  })

  it('returns undefined for forged or malformed frames instead of throwing', () => {
    expect(parseKernelFrame(null)).toBeUndefined()
    expect(parseKernelFrame('x')).toBeUndefined()
    expect(parseKernelFrame({ type: 'ready' })).toBeUndefined()
    expect(parseKernelFrame({ type: 'ready', pid: '42' })).toBeUndefined()
    expect(parseKernelFrame({ type: 'error', id: 1, ename: 2, evalue: 3, traceback: [4] })).toBeUndefined()
    const baked = parseKernelFrame({ type: 'done', id: 'x', status: 'bogus' }) as Extract<KernelFrame, { type: 'done' }> | undefined
    expect(baked?.type).toBe('done')
    expect(baked?.status).toBe('error')
    expect(parseKernelFrame({ type: 'bogus' })).toBeUndefined()
  })

  it('distills done frames into the failure taxonomy', () => {
    expect(doneFailure({ type: 'done', id: 'x', status: 'ok' }).ok).toBe(true)
    const failed = doneFailure({ type: 'done', id: 'x', status: 'error' })
    expect(failed.ok).toBe(false)
    const invalid = doneFailure({ type: 'done', id: 'x', status: 'error', invalidOutput: true })
    expect(invalid.ok).toBe(false)
    if (!invalid.ok) expect(invalid.error.kind).toBe('invalid-output')
    const withMessage = doneFailure({ type: 'done', id: 'x', status: 'error', message: 'nope' })
    expect(withMessage.ok).toBe(false)
    if (!withMessage.ok) expect(withMessage.error.message).toBe('nope')
  })
})

describe('presentation projectors (pure)', () => {
  it('renders a call view and meta for a completed run', () => {
    const value = { value: 42 as const, logs: ['step 1', 'step 2'], executionCount: 2 }
    const meta = runKernelCodeMeta(value)
    expect(meta.summary).toBe('completed')
    expect(meta.executionCount).toBe(2)
    expect(meta.logs).toEqual(['step 1', 'step 2'])

    const view = presentRunKernelCodeResult({ language: 'python', code: 'x = 1' }, { isError: false, content: [], meta: meta })
    expect(view?.card).toBe('terminal')
    expect(view?.output).toContain('42')
    expect(view?.output).toContain('step 2')
  })

  it('presents an error run without projecting from an error result', () => {
    expect(presentRunKernelCodeResult({ language: 'python', code: '1/0' }, { isError: true, content: [] })).toBeUndefined()
  })

  it('labels a pending call with its language and session', () => {
    const view = presentRunKernelCodeCall({ language: 'typescript', code: 'return 1', session: 's1' })
    expect(view.card).toBe('terminal')
    expect(view.title).toContain('typescript')
    expect(view.title).toContain('s1')
  })
})

describe('run_kernel_code over the real tool runtime', () => {
  beforeEach(async () => {
    ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime, {})
    kernelsFiber = ctx.plugin(Kernels, { languages: ['python', 'typescript'], snapshotDir: tempSnapshotDir() })
    await kernelsFiber
  })

  afterEach(async () => {
    // Disposing the plugin fiber runs our ctx.effect disposer: every session
    // kernel is shut down to quiescence before the next test mounts a fresh set.
    await kernelsFiber.dispose()
    cleanTempSnapshotDirs()
  })

  it('runs a one-shot program and renders its completion value', async () => {
    const result = await call('run_kernel_code', { language: 'python', code: '3 * 7' })
    expect(result.isError).toBe(false)
    const text = result.content.filter(block => block.type === 'text').map(block => block.text).join('')
    expect(text).toContain('value: 21')
  })

  it('keeps session state across consecutive tool calls', async () => {
    const seed = await call('run_kernel_code', { language: 'typescript', code: 'state.n = (state.n ?? 0) + 1\nreturn state.n', session: 'counter' })
    expect(seed.isError).toBe(false)
    const next = await call('run_kernel_code', { language: 'typescript', code: 'return state.n', session: 'counter' })
    const text = next.content.filter(block => block.type === 'text').map(block => block.text).join('')
    expect(text).toContain('value: 1')
  })

  it('resets a session to fresh state', async () => {
    await call('run_kernel_code', { language: 'python', code: 'x = 41', session: 's' })
    const reset = await call('run_kernel_code', { language: 'python', code: 'x', session: 's', reset: true })
    const text = reset.content.filter(block => block.type === 'text').map(block => block.text).join('')
    expect(text).toMatch(/exception/)
  })

  it('surfaces the failure taxonomy for an exception', async () => {
    const result = await call('run_kernel_code', { language: 'typescript', code: "throw new Error('kapow')" })
    expect(result.isError).toBe(false)
    const text = result.content.filter(block => block.type === 'text').map(block => block.text).join('')
    expect(text).toMatch(/exception: kapow/)
  })

  it('rejects unknown languages at the schema level', async () => {
    const result = await call('run_kernel_code', { language: 'ruby', code: 'x' })
    expect(result.isError).toBe(true)
  })
})

describe('contract misuse', () => {
  it('rejects an invalid binding global at run time', async () => {
    const manager = new Kernels.KernelManager({ languages: ['python'], snapshotDir: tempSnapshotDir() })
    try {
      await expect(manager.run({
        language: 'python',
        code: '1',
        bindings: [{ global: 'not-valid', functions: {} }],
      })).rejects.toThrow(/not a usable identifier/)
    } finally {
      await manager.teardown()
    }
  })
})
