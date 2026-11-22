/**
 * Request-runtime behavior of the python runner: the per-exec `cwd` contract
 * (a dead session cwd falls back with a stderr warning and never enters
 * `sys.path`) and the `PYTHONUTF8=1` spawn environment reaching the
 * interpreter.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { KernelManager } from '../src/index.ts'
import { cleanTempSnapshotDirs, tempSnapshotDir } from './test-util.ts'

const dirs: string[] = []

afterEach(() => {
  cleanTempSnapshotDirs()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function makeManager(): KernelManager {
  return new KernelManager({ languages: ['python'], snapshotDir: tempSnapshotDir() })
}

describe('python runner request runtime', () => {
  it('warns and falls back to the last valid cwd when the requested cwd is dead', { timeout: 30_000 }, async () => {
    // The runner process sits in the test's own cwd, so `os.getcwd()` still
    // works and is the expected fallback; `gone` is never created.
    const parent = mkdtempSync(join(tmpdir(), 'dsh-kernels-cwd-'))
    dirs.push(parent)
    const dead = join(parent, 'gone')
    const manager = makeManager()
    try {
      const result = await manager.run({
        language: 'python',
        code: 'import os, sys\nprint(os.getcwd())\nprint(any("gone" in entry for entry in sys.path))',
        cwd: dead,
      })
      expect(result.error).toBeUndefined()
      const logs = result.logs.join('')
      expect(logs).toContain(`Warning: session cwd ${dead} is unavailable`)
      expect(logs).toContain(`this cell runs in ${process.cwd()}`)
      expect(logs).toContain('False\n')
    } finally {
      await manager.teardown()
    }
  })

  it('falls back to HOME when even the last valid cwd is gone', { timeout: 30_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-kernels-cwd-'))
    dirs.push(dir)
    const manager = makeManager()
    try {
      // Move the runner process into `dir`, then delete it out from under the
      // process: the next exec's chdir fails AND `os.getcwd()` fails, so the
      // fallback is HOME.
      await manager.run({ language: 'python', code: 'import os\nos.getcwd()', sessionId: 'cwd-fallback', cwd: dir })
      rmSync(dir, { recursive: true, force: true })
      const result = await manager.run({
        language: 'python',
        code: 'import os\nprint(os.getcwd())',
        sessionId: 'cwd-fallback',
        cwd: join(dir, 'also-gone'),
      })
      expect(result.error).toBeUndefined()
      const logs = result.logs.join('')
      expect(logs).toContain(`Warning: session cwd ${join(dir, 'also-gone')} is unavailable`)
      expect(logs).toContain(`this cell runs in ${homedir()}`)
      expect(logs).toContain(`${homedir()}\n`)
    } finally {
      await manager.teardown()
    }
  })

  it('spawns the runner with PYTHONUTF8=1 so the interpreter decodes pipes as UTF-8', { timeout: 30_000 }, async () => {
    const manager = makeManager()
    try {
      const result = await manager.run({ language: 'python', code: 'import sys\nprint(sys.flags.utf8_mode)' })
      expect(result.error).toBeUndefined()
      expect(result.logs.join('')).toContain('1\n')
    } finally {
      await manager.teardown()
    }
  })
})
