/**
 * Runner staging hardening (omp 3664bbf684 + 4bd3dc5637): the OS temp dir is
 * shared between accounts, so the staging dir is per-uid and 0700, an existing
 * dir is validated through the owner-private guard (symlink / non-directory /
 * foreign owner / lingering group-other access refused, normalized through a
 * pinned fd), and a squatted name falls back to a fresh private mkdtemp dir.
 * Windows keeps a plain mkdir of the fixed name (no uid, no O_NOFOLLOW), so
 * the POSIX-only assertions skip there.
 */

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { assertOwnerPrivateDir, ownerPrivateDirError, resolveRunnerStagingDir } from '../src/core/staging.ts'

const uid = process.getuid?.()

/** Every temp path this spec created; afterEach removes exactly these. */
const created: string[] = []

/** Track a temp path for cleanup. */
function track(path: string): string {
  created.push(path)
  return path
}

afterEach(() => {
  // Explicit tracked paths only: a shared-prefix readdir sweep would delete
  // other specs' live tempSnapshotDir dirs running in parallel workers.
  for (const path of created) {
    try {
      rmSync(path, { recursive: true, force: true })
    } catch {
      // Best-effort: a locked leftover in the OS temp dir is not a test failure.
    }
  }
  created.length = 0
})

/** A unique staging base name for one test. */
function uniqueDirName(): string {
  return `dsh-kernels-test-${Math.random().toString(36).slice(2, 10)}`
}

describe('runner staging dir hardening (omp 3664bbf684 + 4bd3dc5637)', () => {
  it.skipIf(uid === undefined)('creates a per-uid 0700 directory and reuses it', () => {
    const dirName = uniqueDirName()
    const dir = track(resolveRunnerStagingDir(dirName))
    expect(dir).toBe(join(tmpdir(), `${dirName}-${uid}`))
    expect(statSync(dir).isDirectory()).toBe(true)
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    // A second resolve re-validates the existing dir and returns it.
    expect(resolveRunnerStagingDir(dirName)).toBe(dir)
  })

  it.skipIf(uid === undefined)('stages in a fresh private dir when the per-uid name is a squatted file', () => {
    const dirName = uniqueDirName()
    writeFileSync(track(join(tmpdir(), `${dirName}-${uid}`)), '')
    const warns: string[] = []
    const warn = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { warns.push(args.map(String).join(' ')) })
    try {
      const dir = track(resolveRunnerStagingDir(dirName))
      // The fallback is a fresh mkdtemp sibling of the squatted name, 0700.
      expect(dir.startsWith(`${join(tmpdir(), `${dirName}-${uid}`)}-`)).toBe(true)
      expect(statSync(dir).isDirectory()).toBe(true)
      expect(statSync(dir).mode & 0o777).toBe(0o700)
      // Staging into it works, and the fallback is loud.
      const staged = join(dir, 'runner-1.py')
      writeFileSync(staged, "print('ours')\n")
      expect(readFileSync(staged, 'utf8')).toBe("print('ours')\n")
      expect(warns.join('\n')).toContain('staging in a fresh private dir')
    } finally {
      warn.mockRestore()
    }
  })

  it.skipIf(uid === undefined)('refuses a runner planted behind a symlinked staging dir', () => {
    const dirName = uniqueDirName()
    const decoy = track(join(tmpdir(), `${dirName}-decoy`))
    mkdirSync(decoy, { mode: 0o777 })
    writeFileSync(join(decoy, 'runner-planted.py'), "print('planted')\n")
    symlinkSync(decoy, track(join(tmpdir(), `${dirName}-${uid}`)), 'dir')
    const dir = track(resolveRunnerStagingDir(dirName))
    expect(realpathSync(dir)).not.toBe(realpathSync(decoy))
    const staged = join(dir, 'runner-1.py')
    writeFileSync(staged, "print('ours')\n")
    expect(readFileSync(staged, 'utf8')).toBe("print('ours')\n")
  })

  it.skipIf(uid === undefined)('refuses a symlink at open time and labels it', () => {
    const target = track(mkdtempSync(join(tmpdir(), 'dsh-kernels-guard-')))
    const link = track(`${target}-link`)
    symlinkSync(target, link, 'dir')
    expect(() => assertOwnerPrivateDir(link, 'Runner staging directory')).toThrow('is a symlink')
  })

  it.skipIf(uid === undefined)('labels a non-directory at open time', () => {
    const base = track(mkdtempSync(join(tmpdir(), 'dsh-kernels-guard-')))
    const file = track(`${base}-file`)
    writeFileSync(file, '')
    expect(() => assertOwnerPrivateDir(file, 'Runner staging directory')).toThrow('is not a directory')
  })

  it.skipIf(uid === undefined)('normalizes a lax-but-owned dir to 0700 through the pinned fd', () => {
    const dir = track(mkdtempSync(join(tmpdir(), 'dsh-kernels-guard-')))
    chmodSync(dir, 0o755)
    assertOwnerPrivateDir(dir, 'Runner staging directory')
    expect(statSync(dir).mode & 0o777).toBe(0o700)
  })

  it('rejects the full owner-private matrix (pure)', () => {
    const mine = uid ?? 0
    expect(ownerPrivateDirError({ isSymlink: true, isDir: true, uid: mine, mode: 0o700 }, mine)).toBe('is a symlink')
    expect(ownerPrivateDirError({ isSymlink: false, isDir: false, uid: mine, mode: 0o700 }, mine)).toBe('is not a directory')
    expect(ownerPrivateDirError({ isSymlink: false, isDir: true, uid: 1, mode: 0o700 }, 2)).toBe('is owned by uid 1, not 2')
    expect(ownerPrivateDirError({ isSymlink: false, isDir: true, uid: mine, mode: 0o750 }, mine)).toBe('must be mode 0700, got 750')
    expect(ownerPrivateDirError({ isSymlink: false, isDir: true, uid: mine, mode: 0o700 }, mine)).toBeNull()
  })
})
