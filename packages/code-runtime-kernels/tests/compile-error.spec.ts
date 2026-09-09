/**
 * Regression tests for python cells that are AST-valid but compile-invalid
 * (a top-level `return`, `break`/`continue` outside a loop). These must
 * settle with an `exception` result promptly — they used to hang forever
 * because the runner emitted a ProtocolError frame with an empty id that the
 * host dropped, leaving the run pending (an indefinitely-blocked tool call).
 */
import { afterAll, describe, expect, it } from 'vitest'
import { KernelManager } from '../src/index.ts'
import { cleanTempSnapshotDirs, tempSnapshotDir } from './test-util.ts'

async function withManager<T>(fn: (manager: KernelManager) => Promise<T>): Promise<T> {
  const manager = new KernelManager({
    languages: ['python'],
    toolTimeoutMs: 15000,
    snapshotDir: tempSnapshotDir(),
  })
  try {
    return await fn(manager)
  } finally {
    await manager.teardown()
  }
}

afterAll(() => {
  cleanTempSnapshotDirs()
})

describe('python compile-time errors settle the run (no hang)', () => {
  const cases: Array<[string, string]> = [
    ['top-level return', 'return 6 * 7'],
    ['break outside loop', 'break'],
    ['continue outside loop', 'continue'],
    ['yield outside function', 'yield 1'],
  ]

  for (const [label, code] of cases) {
    it(`${label} → resolved exception error`, { timeout: 20000 }, async () => {
      await withManager(async (manager) => {
        const result = await manager.run({ language: 'python', code, sessionId: 'compile-error-case' })
        expect(result.error).toBeDefined()
        expect(result.error?.kind).toBe('exception')
        expect(String(result.error?.message)).toContain('invalid Python source')
      })
    })
  }

  it('valid statement code still completes after a compile-error cell in the same session', { timeout: 20000 }, async () => {
    await withManager(async (manager) => {
      const bad = await manager.run({ language: 'python', code: 'return 1', sessionId: 's-recover' })
      expect(bad.error).toBeDefined()
      const good = await manager.run({ language: 'python', code: 'x = 41', sessionId: 's-recover' })
      expect(good.error).toBeUndefined()
      const ret = await manager.run({ language: 'python', code: 'x + 1', sessionId: 's-recover' })
      expect(ret.error).toBeUndefined()
      expect(ret.value).toBe(42)
    })
  })
})
