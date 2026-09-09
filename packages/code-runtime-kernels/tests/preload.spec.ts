/**
 * Session preload ("toolbox", config `preload`): a hidden first cell on every
 * fresh session kernel, before the snapshot restore — helpers are available,
 * but restored user state shadows same-named helpers.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { KernelManager } from '../src/index.ts'
import { cleanTempSnapshotDirs, tempSnapshotDir } from './test-util.ts'

function makeManager(overrides: Record<string, unknown> = {}): KernelManager {
  return new KernelManager({
    languages: ['python', 'typescript'],
    snapshotDir: tempSnapshotDir(),
    ...overrides,
  })
}

afterEach(() => {
  cleanTempSnapshotDirs()
})

describe('session preload (toolbox)', () => {
  it('makes helpers available to session runs (python + typescript)', async () => {
    const manager = makeManager({
      preload: {
        python: 'def helper(x):\n    return x * 2',
        // The TS kernel evaluates cells through `new Function` (async body),
        // so the source is plain JS and helpers persist via `state`.
        typescript: 'state.helper = function helper(x) { return x * 2 }',
      },
    })
    try {
      const py = await manager.run({ language: 'python', sessionId: 'p', code: 'helper(21)' })
      expect(py.error).toBeUndefined()
      expect(py.value).toBe(42)
      const ts = await manager.run({ language: 'typescript', sessionId: 't', code: 'return state.helper(21)' })
      expect(ts.error).toBeUndefined()
      expect(ts.value).toBe(42)
    } finally {
      await manager.teardown()
    }
  })

  it('runs the preload as one hidden cell (execution count +1, logs hidden)', async () => {
    const manager = makeManager({
      preload: { python: 'print("preload-visible?")' },
    })
    try {
      const first = await manager.run({ language: 'python', sessionId: 'hidden', code: '1 + 1' })
      expect(first.error).toBeUndefined()
      // preload cell + user cell = execution count 2 on the first session run
      expect(first.executionCount).toBe(2)
      expect(first.logs.join('\n')).not.toContain('preload-visible?')
    } finally {
      await manager.teardown()
    }
  })

  it('fails the run loudly when the preload raises', async () => {
    const manager = makeManager({
      preload: { python: 'raise RuntimeError("toolbox exploded")' },
    })
    try {
      const result = await manager.run({ language: 'python', sessionId: 'broken', code: '1 + 1' })
      expect(result.error?.kind).toBe('exception')
      expect(result.error?.message).toContain('toolbox exploded')
    } finally {
      await manager.teardown()
    }
  })

  it('never preloads one-shot (session-less) runs', async () => {
    const manager = makeManager({
      preload: { python: 'def helper(x):\n    return x * 2' },
    })
    try {
      const result = await manager.run({ language: 'python', code: 'helper(1)' })
      expect(result.error?.kind).toBe('exception')
      expect(result.error?.message).toContain('helper')
    } finally {
      await manager.teardown()
    }
  })
})
