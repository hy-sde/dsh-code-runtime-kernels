/**
 * Real-subprocess tests for the persistent kernels: `python` (the embedded
 * runner staged to a scratch `.py`) and `typescript` (the compiled runner
 * spawned with `node --no-warnings`), exercised through `KernelManager.run`.
 * These spawn real interpreters, mirroring the fork's kernel/provider specs:
 * persistence across sessions, `reset`, session isolation, one-shot runs,
 * binding re-entry with typed rejection, budget enforcement (wall clock,
 * output bytes), abort, and the failure taxonomy.
 */

import { describe, expect, it } from 'vitest'
import type { CodeBindingNamespace } from '@deepseek-ai/dsh-code-runtime'
import { KernelManager } from '../src/index.ts'

const LANGUAGES = ['python', 'typescript'] as const

function makeManager(overrides: Record<string, unknown> = {}): KernelManager {
  return new KernelManager({ languages: [...LANGUAGES], ...overrides })
}

/** Host functions bridged into every kernel as the `tools` namespace (one args bundle per call, per the seam). */
const TOOLS_NAMESPACE: CodeBindingNamespace = {
  global: 'tools',
  functions: {
    add: async (args: unknown) => {
      const { a, b } = args as { a: number; b: number }
      return a + b
    },
    greet: async () => 'hello-from-host',
    fail: async () => {
      throw new Error('binding exploded')
    },
  },
  errorClass: { name: 'ToolsError', memberNameProperty: 'toolsErrorMember' },
}

async function withManager<T>(
  fn: (manager: KernelManager) => Promise<T>,
  overrides: Record<string, unknown> = {},
): Promise<T> {
  const manager = makeManager(overrides)
  try {
    return await fn(manager)
  } finally {
    await manager.teardown()
  }
}

describe('persistent kernels — sessions', () => {
  for (const language of LANGUAGES) {
    it(`keeps state across calls in one session (${language})`, async () => {
      await withManager(async manager => {
        const seed = language === 'python'
          ? 'x = 41'
          : 'state.x = 41'
        const read = language === 'python'
          ? 'x + 1'
          : 'return state.x + 1'
        const first = await manager.run({ language, sessionId: 's', code: seed })
        expect(first.error).toBeUndefined()
        const second = await manager.run({ language, sessionId: 's', code: read })
        expect(second.error).toBeUndefined()
        expect(second.value).toBe(42)
        expect(second.executionCount).toBe(2)
        expect(first.executionCount).toBe(1)
      })
    })

        it(`reports executionCount and resets discard state (${language})`, async () => {
      await withManager(async manager => {
        await manager.run({ language, sessionId: 's', code: language === 'python' ? 'x = 1' : 'state.x = 1' })
        const reset = await manager.run({ language, sessionId: 's', reset: true, code: language === 'python' ? 'x' : 'return missingKernelVar' })
        expect(reset.error?.kind).toBe('exception')
      })
    })

    it(`isolates state between session ids (${language})`, async () => {
      await withManager(async manager => {
        await manager.run({ language, sessionId: 'a', code: language === 'python' ? 'x = 7' : 'state.x = 7' })
        const fresh = await manager.run({ language, sessionId: 'b', code: language === 'python' ? 'x' : 'return missingKernelVar' })
        expect(fresh.error?.kind).toBe('exception')
      })
    })

    it(`one-shot runs never share state (${language})`, async () => {
      await withManager(async manager => {
        const first = await manager.run({ language, code: language === 'python' ? 'x = 7\nx' : 'state.x = 7; return state.x' })
        expect(first.value).toBe(7)
        const second = await manager.run({ language, code: language === 'python' ? 'x' : 'return missingKernelVar' })
        expect(second.error?.kind).toBe('exception')
      })
    })
  }
})

describe('persistent kernels — binding re-entry', () => {
  for (const language of LANGUAGES) {
    it(`bridges host functions and surfaces typed rejections (${language})`, async () => {
      await withManager(async manager => {
        const call = language === 'python'
          ? 'await tools.add({"a": 3, "b": 4})'
          : 'return await tools.add({ a: 3, b: 4 })'
        const result = await manager.run({ language, sessionId: 'b', code: call, bindings: [TOOLS_NAMESPACE] })
        expect(result.error).toBeUndefined()
        expect(result.value).toBe(7)

        const greet = language === 'python'
          ? 'await tools.greet()'
          : 'return await tools.greet()'
        const greeted = await manager.run({ language, sessionId: 'b', code: greet, bindings: [TOOLS_NAMESPACE] })
        expect(greeted.value).toBe('hello-from-host')

        const typed = language === 'python'
          ? ['try:', '    await tools.fail()', '    out = "no"', 'except ToolsError as e:', '    out = e.toolsErrorMember', 'out'].join('\n')
          : ['try { await tools.fail() } catch (e) { if (e instanceof ToolsError) return e.toolsErrorMember; return String(e) }'].join('\n')
        const rejected = await manager.run({ language, sessionId: 'b', code: typed, bindings: [TOOLS_NAMESPACE] })
        expect(rejected.error).toBeUndefined()
        expect(rejected.value).toBe('fail')
      })
    })
  }
})

describe('persistent kernels — failure taxonomy', () => {
  for (const language of LANGUAGES) {
    it(`classifies a program exception (${language})`, async () => {
      await withManager(async manager => {
        const code = language === 'python' ? '1 / 0' : "throw new Error('boom')"
        const result = await manager.run({ language, code })
        expect(result.error?.kind).toBe('exception')
        expect(result.error?.message.length).toBeGreaterThan(0)
      })
    })

    it(`classifies an invalid (non-lossless-JSON) completion (${language})`, async () => {
      await withManager(async manager => {
        const code = language === 'python'
          ? '{1, 2}'
          : 'const x = {}; x.self = x; return x'
        const result = await manager.run({ language, code })
        expect(result.error?.kind).toBe('invalid-output')
      })
    })

    it(`enforces the wall-clock budget as a timeout (${language})`, async () => {
      await withManager(async manager => {
        const code = language === 'python' ? 'while True:\n    pass' : 'await new Promise(() => {})'
        const result = await manager.run({
          language,
          code,
          sessionId: 'busy',
        })
        expect(result.error?.kind).toBe('timeout')
      }, { maxWallMs: 500 })
    })

    it(`aborts a run whose caller signal fires (${language})`, async () => {
      await withManager(async manager => {
        const controller = new AbortController()
        const pending = manager.run({ language, code: language === 'python' ? 'while True:\n    pass' : 'await new Promise(() => {})', signal: controller.signal })
        setTimeout(() => controller.abort(new Error('caller gave up')), 80)
        const result = await pending
        expect(result.error?.kind).toBe('abort')
      })
    })

    it(`caps combined output at maxOutputBytes (${language})`, async () => {
      await withManager(async manager => {
        const code = language === 'python'
          ? "'x' * 200"
          : "return 'x'.repeat(200)"
        const result = await manager.run({ language, code })
        expect(result.error?.kind).toBe('output-limit')
      }, { maxOutputBytes: 64 })
    })
  }

  it('uncaps output when within budget and surfaces a completion value', async () => {
    await withManager(async manager => {
      for (const language of LANGUAGES) {
        const result = await manager.run({
          language,
          code: language === 'python' ? "print('hi there')\n3 * 7" : "console.log('hi there')\nreturn 3 * 7",
        })
        expect(result.error).toBeUndefined()
        expect(result.value).toBe(21)
        expect(result.logs.join('')).toContain('hi there')
      }
    })
  })
})

describe('persistent kernels — async cells', () => {
  for (const language of LANGUAGES) {
    it(`runs top-level await (${language})`, async () => {
      await withManager(async manager => {
        const code = language === 'python'
          ? "import asyncio\nr = await asyncio.sleep(0, 21)\nr * 2"
          : 'const v = await Promise.resolve(21)\nreturn v * 2'
        const result = await manager.run({ language, code })
        expect(result.error).toBeUndefined()
        expect(result.value).toBe(42)
      })
    })
  }
})

describe('rundown', () => {
  it('disposeAll terminates every kernel cleanly', async () => {
    const manager = makeManager()
    await manager.run({ language: 'python', sessionId: 'p', code: '1' })
    await manager.run({ language: 'typescript', sessionId: 'j', code: 'return 1' })
    await expect(manager.teardown()).resolves.toBeUndefined()
  })
})
