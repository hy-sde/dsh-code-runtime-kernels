/**
 * Namespace-persistence (snapshot/restore) tests: after every successful run a
 * session's kernel namespace is snapshotted to disk, and a fresh kernel for
 * the session restores it once — so state survives kernel death (a model cell
 * that kills the process), `reset` discards it (snapshot deleted), and a full
 * manager restart resumes it. The restore notice names what was revived and
 * what could not be. Real subprocesses, both languages.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { KernelManager } from '../src/index.ts'
import { cleanTempSnapshotDirs, tempSnapshotDir } from './test-util.ts'

afterEach(() => {
  cleanTempSnapshotDirs()
})

async function withManager<T>(
  fn: (manager: KernelManager) => Promise<T>,
  overrides: Record<string, unknown> = {},
): Promise<T> {
  const manager = new KernelManager({
    languages: ['python', 'typescript'],
    snapshotDir: tempSnapshotDir(),
    ...overrides,
  })
  try {
    return await fn(manager)
  } finally {
    await manager.teardown()
  }
}

describe('session snapshots — restore after kernel death', () => {
  it('python: a cell that kills the kernel loses nothing (data + function + class + module)', { timeout: 30000 }, async () => {
    await withManager(async (manager) => {
      const seed = await manager.run({
        language: 'python',
        sessionId: 's',
        code: 'x = 41\nimport math\ndef double(v):\n    return v * 2\nclass Counter:\n    def __init__(self, n):\n        self.n = n',
      })
      expect(seed.error).toBeUndefined()
      const crash = await manager.run({ language: 'python', sessionId: 's', code: 'import os; os._exit(0)' })
      expect(crash.error).toBeDefined()
      const restored = await manager.run({ language: 'python', sessionId: 's', code: 'double(x) + math.floor(math.pi)' })
      expect(restored.error).toBeUndefined()
      expect(restored.value).toBe(85)
      expect(restored.logs.join('\n')).toMatch(/restored \d+ names from snapshot/)
    })
  })

  it('typescript: state survives a cell that exits the process', { timeout: 30000 }, async () => {
    await withManager(async (manager) => {
      const seed = await manager.run({
        language: 'typescript',
        sessionId: 's',
        code: 'state.x = 41; state.keep = { a: 1, b: [1, 2, 3] }\nreturn 1',
      })
      expect(seed.error).toBeUndefined()
      await manager.run({ language: 'typescript', sessionId: 's', code: 'process.exit(0)' })
      const restored = await manager.run({
        language: 'typescript',
        sessionId: 's',
        code: 'return [state.x, state.keep, state.missing === undefined]',
      })
      expect(restored.error).toBeUndefined()
      expect(restored.value).toEqual([41, { a: 1, b: [1, 2, 3] }, true])
      expect(restored.logs.join('\n')).toMatch(/restored \d+ names from snapshot/)
    })
  })
})

describe('session snapshots — honest loss reporting', () => {
  it('python: unpicklable bindings are named in the restore notice, not dropped silently', { timeout: 30000 }, async () => {
    await withManager(async (manager) => {
      await manager.run({
        language: 'python',
        sessionId: 's',
        code: 'x = 1\nobj = object()\nclass Box:\n    def __init__(self):\n        self.v = 1\nbox = Box()',
      })
      await manager.run({ language: 'python', sessionId: 's', code: 'import os; os._exit(0)' })
      const restored = await manager.run({
        language: 'python',
        sessionId: 's',
        code: 'sorted(k for k in globals() if not k.startswith("_"))',
      })
      expect(restored.error).toBeUndefined()
      expect(restored.value).toContain('x')
      expect(restored.value).toContain('Box')
      expect(restored.value).toContain('obj') // object() is picklable by value
      expect(restored.value).not.toContain('box') // a user-class instance is not
      expect(restored.logs.join('\n')).toMatch(/could not restore: box/)
    })
  })

  it('typescript: function-valued state keys are named in the restore notice', { timeout: 30000 }, async () => {
    await withManager(async (manager) => {
      await manager.run({ language: 'typescript', sessionId: 's', code: 'state.fn = () => 7; state.keep = [1, 2]\nreturn 1' })
      await manager.run({ language: 'typescript', sessionId: 's', code: 'process.exit(0)' })
      const restored = await manager.run({ language: 'typescript', sessionId: 's', code: 'return [typeof state.fn, state.keep]' })
      expect(restored.error).toBeUndefined()
      expect(restored.value).toEqual(['undefined', [1, 2]])
      expect(restored.logs.join('\n')).toMatch(/could not restore: fn/)
    })
  })
})

describe('session snapshots — reset and disable', () => {
  it('python: reset discards persisted state (snapshot deleted before the fresh kernel runs)', { timeout: 30000 }, async () => {
    await withManager(async (manager) => {
      await manager.run({ language: 'python', sessionId: 's', code: 'x = 1' })
      const after = await manager.run({ language: 'python', sessionId: 's', reset: true, code: "'x' in globals()" })
      expect(after.error).toBeUndefined()
      expect(after.value).toBe(false)
    })
  })

  it('python: snapshot: false persists nothing across a kernel death', { timeout: 30000 }, async () => {
    await withManager(async (manager) => {
      await manager.run({ language: 'python', sessionId: 's', code: 'x = 1' })
      await manager.run({ language: 'python', sessionId: 's', code: 'import os; os._exit(0)' })
      const after = await manager.run({ language: 'python', sessionId: 's', code: "'x' in globals()" })
      expect(after.value).toBe(false)
      expect(after.logs.join('\n')).not.toMatch(/restored \d+ names/)
    }, { snapshot: false })
  })
})

describe('session snapshots — host restart', () => {
  it('python: a new manager over the same snapshotDir resumes the session', { timeout: 30000 }, async () => {
    const dir = tempSnapshotDir()
    const first = new KernelManager({ languages: ['python'], snapshotDir: dir })
    try {
      const seed = await first.run({ language: 'python', sessionId: 's', code: 'x = 41' })
      expect(seed.error).toBeUndefined()
    } finally {
      await first.teardown()
    }
    const second = new KernelManager({ languages: ['python'], snapshotDir: dir })
    try {
      const restored = await second.run({ language: 'python', sessionId: 's', code: 'x + 1' })
      expect(restored.error).toBeUndefined()
      expect(restored.value).toBe(42)
      expect(restored.logs.join('\n')).toMatch(/restored 1 names from snapshot/)
    } finally {
      await second.teardown()
    }
  })
})
