/**
 * Cell source registration in the python runner: every cell runs under a
 * `<cell-N>` filename, its source is registered in `linecache` so
 * `inspect.getsource` and tracebacks resolve cells, and `__file__` stays
 * unset (cells are not files).
 */

import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { KernelManager } from '../src/index.ts'
import { cleanTempSnapshotDirs, tempSnapshotDir } from './test-util.ts'

afterEach(() => {
  cleanTempSnapshotDirs()
  rmSync(join(tmpdir(), 'dsh-kernels-cell-source'), { recursive: true, force: true })
})

function makeManager(): KernelManager {
  return new KernelManager({ languages: ['python'], snapshotDir: tempSnapshotDir() })
}

describe('python runner cell source', () => {
  it('resolves a function defined in an earlier cell via inspect.getsource', { timeout: 30_000 }, async () => {
    const manager = makeManager()
    await manager.run({ language: 'python', code: 'def f():\n    return 21', sessionId: 'cell-source-def' })
    const result = await manager.run({
      language: 'python',
      code: 'import inspect\nprint(inspect.getsource(f))',
      sessionId: 'cell-source-def',
    })
    const logs = result.logs.join('')
    expect(result.error).toBeUndefined()
    expect(logs).toContain('def f():')
    expect(logs).toContain('return 21')
  })

  it('inspects the running cell itself through inspect.currentframe()', { timeout: 30_000 }, async () => {
    const manager = makeManager()
    const result = await manager.run({
      language: 'python',
      code: 'import inspect\nprint(inspect.getsource(inspect.currentframe()))',
      sessionId: 'cell-source-self',
    })
    const logs = result.logs.join('')
    expect(result.error).toBeUndefined()
    expect(logs).toContain('inspect.getsource(inspect.currentframe())')
  })

  it('names the cell in caught tracebacks as File "<cell-1>"', { timeout: 30_000 }, async () => {
    const manager = makeManager()
    const result = await manager.run({
      language: 'python',
      code: 'try:\n    1 / 0\nexcept ZeroDivisionError:\n    import traceback\n    print(traceback.format_exc())',
      sessionId: 'cell-source-traceback',
    })
    const logs = result.logs.join('')
    expect(result.error).toBeUndefined()
    expect(logs).toContain('File "<cell-1>", line 2')
    expect(logs).toContain('1 / 0')
  })

  it('leaves __file__ unset in cell globals', { timeout: 30_000 }, async () => {
    const manager = makeManager()
    const result = await manager.run({
      language: 'python',
      code: 'print("__file__" in globals())',
      sessionId: 'cell-source-file',
    })
    const logs = result.logs.join('')
    expect(result.error).toBeUndefined()
    expect(logs).toContain('False')
  })
})
