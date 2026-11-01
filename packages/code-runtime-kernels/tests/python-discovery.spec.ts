/**
 * Python interpreter resolution: PATH enumeration (`whichAll`), per-candidate
 * probing, resolution order (`config.pythonPath` first, `python` matches
 * before `python3`), the verified-candidate cache, and the aggregated
 * rejection when no candidate works. Shell-script shims stand in for
 * interpreters; only the kernel-boot integration shims `exec` the real
 * system python3 (guarded, like the rest of the suite).
 */

import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  enumeratePythonCandidates,
  probePythonInterpreter,
  resolvePythonCommand,
  whichAll,
} from '../src/core/python-discovery.ts'
import { KernelManager } from '../src/index.ts'
import { cleanTempSnapshotDirs, tempSnapshotDir } from './test-util.ts'

/** Real system python3, discovered once from the ambient PATH for exec/symlink fixtures. */
const systemPython3 = whichAll('python3')[0]

const fixtures: string[] = []

afterEach(() => {
  cleanTempSnapshotDirs()
  for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** One disposable fixture directory for shims. */
function makeFixtureDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-kernels-py-'))
  fixtures.push(dir)
  return dir
}

/** A shell-script shim: ignores its argv, runs `body`, and is executable unless `executable` is false. */
function writeShim(dir: string, name: string, body: string, executable = true): string {
  const file = join(dir, name)
  writeFileSync(file, `#!/bin/sh\n${body}\n`, 'utf8')
  chmodSync(file, executable ? 0o755 : 0o644)
  return file
}

/** A shim that behaves like a working interpreter for the full kernel boot: exec the real python3. */
function writeExecPythonShim(dir: string, name: string): string {
  if (systemPython3 === undefined) throw new Error('exec-python shim requires a system python3')
  return writeShim(dir, name, `exec '${systemPython3}' "$@"`)
}

/** Run `fn` with `PATH` narrowed to `path` and restored afterwards (no ambient interpreter leaks in). */
async function withPath<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.env.PATH
  process.env.PATH = path
  try {
    return await fn()
  } finally {
    if (previous === undefined) delete process.env.PATH
    else process.env.PATH = previous
  }
}

describe('whichAll', () => {
  it('returns every executable match in PATH order', () => {
    const first = makeFixtureDir()
    const second = makeFixtureDir()
    const a = writeShim(first, 'python', 'exit 0')
    const b = writeShim(second, 'python', 'exit 0')
    expect(whichAll('python', { PATH: `${first}${delimiter}${second}` })).toEqual([a, b])
  })

  it('skips non-executable files, directories, and missing names', () => {
    const dir = makeFixtureDir()
    writeShim(dir, 'python', 'exit 0', false)
    mkdirSync(join(dir, 'python3'))
    expect(whichAll('python', { PATH: dir })).toEqual([])
    expect(whichAll('python3', { PATH: dir })).toEqual([])
    expect(whichAll('nothing-here', { PATH: dir })).toEqual([])
  })

  it('skips empty PATH entries and dedupes repeated directories', () => {
    const dir = makeFixtureDir()
    const shim = writeShim(dir, 'python', 'exit 0')
    expect(whichAll('python', { PATH: `${delimiter}${dir}${delimiter}${dir}` })).toEqual([shim])
  })

  it('on win32 matches the .exe interpreter before the literal name in each entry', () => {
    const dir = makeFixtureDir()
    const exe = writeShim(dir, 'python.exe', 'exit 0')
    const bare = writeShim(dir, 'python', 'exit 0')
    expect(whichAll('python', { PATH: dir }, 'win32')).toEqual([exe, bare])
  })

  it('on posix ignores .exe-named files', () => {
    const dir = makeFixtureDir()
    writeShim(dir, 'python.exe', 'exit 0')
    expect(whichAll('python', { PATH: dir }, 'darwin')).toEqual([])
  })
})

describe('probePythonInterpreter', () => {
  it('accepts a shim that reports a python version', async () => {
    const shim = writeShim(makeFixtureDir(), 'python', "printf '3.13.5\\n'")
    await expect(probePythonInterpreter(shim, 5_000)).resolves.toBeUndefined()
  })

  it('surfaces the exit code and stderr of a failing shim', async () => {
    const shim = writeShim(makeFixtureDir(), 'python', 'echo "mise: no version is set" >&2\nexit 1')
    await expect(probePythonInterpreter(shim, 5_000))
      .resolves.toBe('exited with code 1: mise: no version is set')
  })

  it('reports a timeout for a hanging shim', { timeout: 5_000 }, async () => {
    // `exec` makes sleep the direct child image, so the probe's kill() lands on it.
    const shim = writeShim(makeFixtureDir(), 'python', 'exec sleep 30')
    await expect(probePythonInterpreter(shim, 300)).resolves.toBe('timed out after 300ms')
  })

  it('rejects a zero-exit shim that reports no version', async () => {
    const shim = writeShim(makeFixtureDir(), 'python', 'echo hello')
    await expect(probePythonInterpreter(shim, 5_000)).resolves.toBe('no version report (hello)')
  })

  it('reports a spawn failure for a missing interpreter', async () => {
    const missing = join(makeFixtureDir(), 'missing-python')
    await expect(probePythonInterpreter(missing, 5_000)).resolves.toMatch(/^spawn failed \(.*ENOENT/)
  })
})

describe('enumeratePythonCandidates', () => {
  it('puts config.pythonPath first, then python matches, then python3 matches, each in PATH order', () => {
    const first = makeFixtureDir()
    const second = makeFixtureDir()
    const pyInSecond = writeShim(second, 'python', 'exit 0')
    const py3InFirst = writeShim(first, 'python3', 'exit 0')
    const py3InSecond = writeShim(second, 'python3', 'exit 0')
    const configured = '/opt/py/bin/python'
    expect(enumeratePythonCandidates(configured, { PATH: `${second}${delimiter}${first}` }))
      .toEqual([configured, pyInSecond, py3InSecond, py3InFirst])
  })

  it('on win32 enumerates .exe interpreters after the configured path', () => {
    const dir = makeFixtureDir()
    const py3 = writeShim(dir, 'python3.exe', 'exit 0')
    const configured = 'C:\\py\\python.exe'
    expect(enumeratePythonCandidates(configured, { PATH: dir }, 'win32')).toEqual([configured, py3])
  })
})

describe('resolvePythonCommand', () => {
  it('resolves the first candidate whose probe passes', async () => {
    const dir = makeFixtureDir()
    const broken = writeShim(dir, 'broken-python', 'exit 1')
    const good = writeShim(dir, 'good-python', "printf '3.13.5\\n'")
    await expect(resolvePythonCommand([broken, good], { probeTimeoutMs: 5_000 })).resolves.toBe(good)
  })

  it('skips probing a candidate the caller already verified', async () => {
    const verified = new Set(['/nonexistent/verified-python'])
    await expect(resolvePythonCommand(['/nonexistent/verified-python'], { probeTimeoutMs: 5_000, verified }))
      .resolves.toBe('/nonexistent/verified-python')
  })

  it('rejects with every candidate and reason when none works', async () => {
    const dir = makeFixtureDir()
    const failing = writeShim(dir, 'failing-python', 'echo "mise: no version is set" >&2\nexit 1')
    const hanging = writeShim(dir, 'hanging-python', 'exec sleep 30')
    // 1s, not a bare 300ms: under a parallel suite the failing shim's spawn+exit
    // can itself exceed a tighter budget and get reported as a timeout, flipping
    // the expected reason.
    const error = await resolvePythonCommand([failing, hanging], { probeTimeoutMs: 1_000 })
      .then(() => undefined, (error: unknown) => error)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe(
      'dsh-code-runtime-kernels: no working python interpreter found '
      + `(${failing}: exited with code 1: mise: no version is set; ${hanging}: timed out after 1000ms); `
      + 'install a working python3 on PATH or set config.pythonPath',
    )
  })
})

describe('KernelManager python resolution', () => {
  it('falls through a broken config.pythonPath to a healthy PATH candidate', { timeout: 30_000 }, async () => {
    if (systemPython3 === undefined) return
    const dir = makeFixtureDir()
    const broken = writeShim(dir, 'broken-python', 'exit 1')
    symlinkSync(systemPython3, join(dir, 'python3'))
    await withPath(dir, async () => {
      const manager = new KernelManager({ languages: ['python'], pythonPath: broken, snapshotDir: tempSnapshotDir() })
      try {
        const result = await manager.run({ language: 'python', code: '40 + 2' })
        expect(result.value).toBe(42)
      } finally {
        await manager.teardown()
      }
    })
  })

  it('probes config.pythonPath before the PATH candidates', { timeout: 30_000 }, async () => {
    if (systemPython3 === undefined) return
    const dir = makeFixtureDir()
    writeShim(dir, 'python', 'exit 1')
    writeShim(dir, 'python3', 'exit 1')
    const configured = writeExecPythonShim(dir, 'configured-python')
    await withPath(dir, async () => {
      const manager = new KernelManager({ languages: ['python'], pythonPath: configured, snapshotDir: tempSnapshotDir() })
      try {
        // Only config.pythonPath can answer: every PATH candidate is a failing shim.
        const result = await manager.run({ language: 'python', code: '40 + 2' })
        expect(result.value).toBe(42)
      } finally {
        await manager.teardown()
      }
    })
  })

  it('rejects a run with the aggregated resolution error when every candidate fails', async () => {
    const dir = makeFixtureDir()
    const failing = writeShim(dir, 'python', 'echo "mise: no version is set" >&2\nexit 1')
    await withPath(dir, async () => {
      const manager = new KernelManager({ languages: ['python'], snapshotDir: tempSnapshotDir() })
      try {
        await expect(manager.run({ language: 'python', code: '1' }))
          .rejects.toThrow(`no working python interpreter found (${failing}: exited with code 1: mise: no version is set)`)
      } finally {
        await manager.teardown()
      }
    })
  })

  it('keeps the resolution error away from the nodejs kernel', { timeout: 30_000 }, async () => {
    const dir = makeFixtureDir()
    writeShim(dir, 'python', 'exit 1')
    await withPath(dir, async () => {
      // Pin nodePath: the narrowed PATH cannot resolve a bare `node` name.
      const manager = new KernelManager({
        languages: ['typescript'],
        nodePath: process.execPath,
        snapshotDir: tempSnapshotDir(),
      })
      try {
        const result = await manager.run({ language: 'typescript', code: 'return 40 + 2' })
        expect(result.value).toBe(42)
      } finally {
        await manager.teardown()
      }
    })
  })
})
