/**
 * Owner-private staging for kernel runner scripts (omp 3664bbf684 +
 * 4bd3dc5637). Runner sources are staged under the OS temp dir so the
 * interpreter can load them as normal files. The temp dir is shared between
 * accounts: a fixed directory name is owned by whichever account creates it
 * first, and every other account's runner write then fails with EACCES. The
 * per-uid name that fixes that is still predictable, so another account can
 * squat it as a symlink, a plain file, or a foreign-owned directory — either
 * to block staging or to plant a runner file for us to execute. Staging
 * therefore resolves a per-uid directory created 0700, validates it through a
 * pinned fd, and falls back to a fresh private mkdtemp dir when the name is
 * not ours.
 * @module @hy-sde-org/dsh-code-runtime-kernels/src/core/staging
 */

import { closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** What a reused staging directory must look like; `null` from the checker when it is safe. */
export interface OwnerPrivateDirStat {
  isSymlink: boolean
  isDir: boolean
  uid: number
  mode: number
}

/**
 * Rejection reason for a staging directory reused from the shared temp base,
 * or `null` when it is a real directory owned by `expectedUid` with no
 * group/other access. Pure so the rejection matrix is testable without root.
 * @param stat - Observed directory facts (from `fstat` through a pinned fd, or synthetic in tests).
 * @param expectedUid - The current account's uid, or `undefined` when the platform has none.
 * @returns The reason the directory must be refused, or `null`.
 */
export function ownerPrivateDirError(stat: OwnerPrivateDirStat, expectedUid: number | undefined): string | null {
  if (stat.isSymlink) return 'is a symlink'
  if (!stat.isDir) return 'is not a directory'
  if (expectedUid !== undefined && stat.uid !== expectedUid) {
    return `is owned by uid ${stat.uid}, not ${expectedUid}`
  }
  if ((stat.mode & 0o777) !== 0o700) return `must be mode 0700, got ${(stat.mode & 0o777).toString(8)}`
  return null
}

/**
 * Validate a directory pulled from the shared temp base, where another local
 * user may have created the path first.
 *
 * Opens the final path component with `O_NOFOLLOW | O_DIRECTORY` so a symlink
 * or non-directory is refused atomically at open time, then inspects and
 * normalizes that one pinned inode through the fd (`fstat`/`fchmod`) — never a
 * second pathname lookup. This closes the swap window where another local user
 * could replace the entry with a symlink between two `stat`s and slip a
 * victim-owned 0700 target past the checks (omp #9070). POSIX only: Windows
 * lacks `O_NOFOLLOW`/`O_DIRECTORY`, so callers on it keep a plain `mkdir`
 * (the per-user temp dir already isolates accounts there).
 * @param dir - Directory to validate.
 * @param label - Human-readable directory role prefixed to the thrown message.
 * @throws When the directory is a symlink, not a directory, foreign-owned, or
 *   still not owner-private after normalization.
 */
export function assertOwnerPrivateDir(dir: string, label: string): void {
  const uid = process.getuid?.()
  let fd: number
  try {
    fd = openSync(dir, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY)
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code
    // O_NOFOLLOW rejects a symlinked final component; kernels report it as
    // ELOOP or (with O_DIRECTORY) ENOTDIR. The entry is already refused —
    // lstat only labels the failure precisely, so a swap after this point
    // cannot weaken the (already-final) rejection.
    if (code === 'ELOOP' || code === 'ENOTDIR') {
      let isSymlink = false
      try {
        isSymlink = lstatSync(dir).isSymbolicLink()
      } catch {
        // The open rejection stands on its own; the label is best-effort.
      }
      throw new Error(`${label} ${dir} ${isSymlink ? 'is a symlink' : 'is not a directory'}`)
    }
    throw error
  }
  try {
    let stat = fstatSync(fd)
    // Normalize perms on the pinned inode only when it is ours; never fchmod
    // a directory another user owns.
    if ((uid === undefined || stat.uid === uid) && (stat.mode & 0o777) !== 0o700) {
      try {
        fchmodSync(fd, 0o700)
        stat = fstatSync(fd)
      } catch {
        // The post-chmod stat below still decides; a failed chmod cannot
        // manufacture access the checks would reject.
      }
    }
    const reason = ownerPrivateDirError(
      { isSymlink: false, isDir: stat.isDirectory(), uid: stat.uid, mode: stat.mode },
      uid,
    )
    if (reason !== null) throw new Error(`${label} ${dir} ${reason}`)
  } finally {
    closeSync(fd)
  }
}

/**
 * Resolve the staging directory for runner scripts: `<dirName>-<uid>` under
 * the OS temp dir, created 0700 and validated with
 * {@link assertOwnerPrivateDir}; a squatted name falls back to a fresh private
 * mkdtemp dir for this process. Called once per spawn (the fork stages per
 * spawn instead of memoizing), so an existing dir is re-validated every time.
 * @param dirName - Base directory name (unique per purpose).
 * @returns A writable directory owned by the current account.
 */
export function resolveRunnerStagingDir(dirName: string): string {
  const uid = process.getuid?.()
  // No uid (Windows): the temp dir is already per-user, and O_NOFOLLOW is
  // unavailable, so the name keeps its plain form with no guard.
  if (uid === undefined) {
    const dir = join(tmpdir(), dirName)
    mkdirSync(dir, { recursive: true })
    return dir
  }
  const dir = join(tmpdir(), `${dirName}-${uid}`)
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    assertOwnerPrivateDir(dir, 'Runner staging directory')
    return dir
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`dsh-code-runtime-kernels: runner staging dir ${JSON.stringify(dir)} is unusable (${message}); staging in a fresh private dir`)
    return mkdtempSync(`${dir}-`)
  }
}
