/**
 * Real-IPython kernel tests (config `pythonImpl: 'ipykernel'`). The runner
 * boots a genuine `InteractiveShell` (magics, `!cmd`, display, top-level
 * await) while keeping our protocol, snapshots, and binding proxies. Skipped
 * unless the test environment points at an interpreter with ipykernel
 * installed (`DSH_TEST_IPYKERNEL_PYTHON`), because the default system python3
 * in CI/dev is deliberately stdlib-only.
 */

import { execSync } from 'node:child_process'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { KernelManager } from '../src/index.ts'
import { cleanTempSnapshotDirs, tempSnapshotDir } from './test-util.ts'

const INTERPRETER = process.env.DSH_TEST_IPYKERNEL_PYTHON
const IPYTHONDIR = `${tempSnapshotDir()}/ipython`

/** True when the default `python3` on PATH already has IPython (then the fail-loud test has nothing to fail on). */
const SYSTEM_HAS_IPYTHON = (() => {
  try {
    execSync('python3 -c "import IPython"', { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

const describeMaybe = INTERPRETER === undefined || INTERPRETER.length === 0 ? describe.skip : describe

function makeManager(): KernelManager {
  return new KernelManager({
    languages: ['python'],
    ...INTERPRETER !== undefined ? { pythonPath: INTERPRETER } : {},
    pythonImpl: 'ipykernel',
    snapshotDir: tempSnapshotDir(),
  })
}

describeMaybe('ipykernel python impl', () => {
  afterEach(() => {
    cleanTempSnapshotDirs()
  })
  afterAll(() => {
    delete process.env.IPYTHONDIR
  })

  it.each([
    ['runs a cell with a real shell and returns the last expression', 'x = 5\nx + 1', 6],
    ['supports top-level await', 'import asyncio\nawait asyncio.sleep(0.01)\n21 * 2', 42],
    ['supports shell magics (!cmd)', '!echo hello-from-ipy\n7', 7],
  ])('%s', async (_label, code, expected) => {
    process.env.IPYTHONDIR = IPYTHONDIR
    const manager = makeManager()
    try {
      const result = await manager.run({ language: 'python', sessionId: 'ipy-basic', code })
      expect(result.error).toBeUndefined()
      expect(result.value).toBe(expected)
      const allLogs = result.logs.join('\n')
      if (code.includes('!echo')) expect(allLogs).toContain('hello-from-ipy')
      // The quiet displayhook must not leak IPython's Out[n] prompts.
      expect(allLogs).not.toMatch(/Out\[\d+\]:/)
    } finally {
      await manager.teardown()
    }
  })

  it('reports a real traceback for an exec error', async () => {
    process.env.IPYTHONDIR = IPYTHONDIR
    const manager = makeManager()
    try {
      const result = await manager.run({ language: 'python', sessionId: 'ipy-error', code: '1 / 0' })
      expect(result.error?.kind).toBe('exception')
      expect(result.error?.message).toContain('division by zero')
      expect(result.logs.join('\n')).toContain('ZeroDivisionError')
    } finally {
      await manager.teardown()
    }
  })

  it('reports a syntax error distinctly', async () => {
    process.env.IPYTHONDIR = IPYTHONDIR
    const manager = makeManager()
    try {
      const result = await manager.run({ language: 'python', sessionId: 'ipy-syntax', code: 'def broken(:' })
      expect(result.error?.kind).toBe('exception')
      expect(result.error?.message).toContain('invalid syntax')
    } finally {
      await manager.teardown()
    }
  })

  it('persists the IPython namespace across kernel death (snapshot restore)', async () => {
    process.env.IPYTHONDIR = IPYTHONDIR
    const manager = makeManager()
    try {
      const seed = await manager.run({ language: 'python', sessionId: 'ipy-death', code: 'x = 5\n[1, 2, 3]' })
      expect(seed.error).toBeUndefined()
      const die = await manager.run({ language: 'python', sessionId: 'ipy-death', code: 'import os\nos._exit(0)' })
      expect(die.error?.kind).toBe('abort')
      const revived = await manager.run({ language: 'python', sessionId: 'ipy-death', code: 'x + 1' })
      expect(revived.error).toBeUndefined()
      expect(revived.value).toBe(6)
      expect(revived.logs.join('\n')).toContain('restored')
    } finally {
      await manager.teardown()
    }
  })

  it('keeps the lossless-JSON completion gate', async () => {
    process.env.IPYTHONDIR = IPYTHONDIR
    const manager = makeManager()
    try {
      const result = await manager.run({ language: 'python', sessionId: 'ipy-json', code: 'class Box:\n    pass\nBox()' })
      expect(result.error?.kind).toBe('invalid-output')
    } finally {
      await manager.teardown()
    }
  })

  it.skipIf(SYSTEM_HAS_IPYTHON)('fails loud when the interpreter lacks IPython', async () => {
    process.env.IPYTHONDIR = IPYTHONDIR
    // system python3: deliberately IPython-free in dev/CI
    const manager = new KernelManager({
      languages: ['python'],
      pythonImpl: 'ipykernel',
      snapshotDir: tempSnapshotDir(),
    })
    try {
      await expect(manager.run({ language: 'python', sessionId: 'ipy-nolib', code: '1 + 1' }))
        .rejects.toThrow(/kernel/i)
    } finally {
      await manager.teardown()
    }
  })
})
