/**
 * Python interpreter discovery and probing for kernel starts. Enumerates the
 * PATH (every match in PATH order, like omp's `$whichAll`) and probes each
 * candidate with a `-c` version check, so a broken shim on PATH falls through
 * to the next candidate instead of failing the kernel start. The probe also
 * enforces a Python 3.9 floor: an older interpreter exits with an encoded
 * code and is named in the failure reason.
 * @module @hy-sde-org/dsh-code-runtime-kernels/src/core/python-discovery
 */

import { spawn } from 'node:child_process'
import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, join } from 'node:path'

/**
 * Every PATH entry where `command` names an executable file, in PATH order.
 * Empty entries are skipped, matches are deduplicated, and a match must be a
 * regular file with the execute bit (a directory or a non-executable file is
 * not a candidate). There is no PATHEXT or platform-toolchain fallback: the
 * PATH scan is the whole contract. On win32 each entry is tried as
 * `command.exe` before the literal name, matching CreateProcessW's
 * exe-first resolution.
 */
export function whichAll(command: string, env: { PATH?: string } = process.env, platform: NodeJS.Platform = process.platform): string[] {
  const names = platform === 'win32' ? [`${command}.exe`, command] : [command]
  const matches: string[] = []
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (dir === '') continue
    for (const name of names) {
      const candidate = join(dir, name)
      try {
        if (!statSync(candidate).isFile()) continue
        accessSync(candidate, constants.X_OK)
      } catch {
        continue
      }
      if (!matches.includes(candidate)) matches.push(candidate)
    }
  }
  return matches
}

/**
 * Ordered python candidates for one resolution: an explicitly configured
 * interpreter first, then every `python3` and every `python` on PATH (each
 * list in PATH order; `python3` outranks `python` because a bare `python`
 * is the name most often shadowed by python2 shims or launcher stubs; on
 * win32, `.exe` matches come before bare names per PATH entry).
 */
export function enumeratePythonCandidates(configured: string | undefined, env: { PATH?: string } = process.env, platform: NodeJS.Platform = process.platform): string[] {
  return [
    ...configured !== undefined ? [configured] : [],
    ...whichAll('python3', env, platform),
    ...whichAll('python', env, platform),
  ]
}

/** The `-c` probe program: reports `MAJOR.MINOR.MICRO`, then exits 0 on python ≥3.9. */
const PYTHON_PROBE_REPORT = "import sys;v=sys.version_info;print('%d.%d.%d' % v[:3])"
/** Too-old exit encoding: `200 + 10*major + minor`, decoded by {@link describePythonProbeExit}. */
const PYTHON_PROBE_TOO_OLD_EXIT = 'sys.exit(0 if v>=(3,9) else 200+min(v[0],3)*10+min(v[1],9))'

const PYTHON_PROBE_PROGRAM = `${PYTHON_PROBE_REPORT};${PYTHON_PROBE_TOO_OLD_EXIT}`

/** Probe stdout that proves the `-c` program ran on a python that prints a version. */
const VERSION_REPORT = /^\d+\.\d+/

/** Exit codes at or above this base encode the rejected python version in `10*major + minor`. */
const TOO_OLD_EXIT_BASE = 200

/** Minimum python minor version the probe accepts. */
const MIN_PYTHON_MINOR = 9

/**
 * The too-old rejection reason for an encoded probe exit code, or `undefined`
 * for any other exit code — those keep the generic exit/signal reason.
 */
function describePythonProbeExit(exitCode: number): string | undefined {
  const encoded = exitCode - TOO_OLD_EXIT_BASE
  // Below 20 is python 1.x or a foreign exit code; above 39 cannot be encoded.
  if (encoded < 20 || encoded > 39) return undefined
  return `Python ${Math.floor(encoded / 10)}.${encoded % 10} is too old; 3.${MIN_PYTHON_MINOR}+ required`
}

/** Failure-reason excerpt cap; the resolution error must stay single-line readable. */
const EXCERPT_MAX_CHARS = 160

/** One bounded, whitespace-collapsed excerpt of process output for failure reasons. */
function outputExcerpt(text: string): string | undefined {
  const line = text.replace(/\s+/g, ' ').trim()
  if (line === '') return undefined
  return line.length > EXCERPT_MAX_CHARS ? `${line.slice(0, EXCERPT_MAX_CHARS)}…` : line
}

/**
 * Probe one candidate with the `-c` version check under `timeoutMs`. Resolves
 * `undefined` when the interpreter works (a version report and exit 0), or a
 * single-line reason otherwise: spawn error, timeout, missing version report,
 * the named too-old version for an encoded exit code, or the generic
 * exit/signal reason with an output excerpt.
 */
export async function probePythonInterpreter(command: string, timeoutMs: number): Promise<string | undefined> {
  const child = spawn(command, ['-c', PYTHON_PROBE_PROGRAM], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    // Decode probe output as UTF-8 regardless of the platform codepage
    // (a Windows ANSI codepage otherwise mangles failure excerpts).
    env: { ...process.env, PYTHONUTF8: '1' },
  })
  return await new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      // Settle immediately: the killed shim's grandchildren can inherit the
      // stdio pipes and hold `close` open well past the budget.
      timedOut = true
      child.kill()
      resolve(`timed out after ${timeoutMs}ms`)
    }, timeoutMs)
    timer.unref()
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    child.on('error', (error: Error) => {
      if (timedOut) return
      clearTimeout(timer)
      resolve(`spawn failed (${error.message})`)
    })
    child.on('close', (code: number | null, signal: string | null) => {
      if (timedOut) return
      clearTimeout(timer)
      if (code === 0 && VERSION_REPORT.test(stdout.trim())) {
        resolve(undefined)
        return
      }
      const excerpt = outputExcerpt(stderr) ?? outputExcerpt(stdout)
      if (code === 0) {
        resolve(`no version report${excerpt !== undefined ? ` (${excerpt})` : ''}`)
        return
      }
      const tooOld = code !== null ? describePythonProbeExit(code) : undefined
      if (tooOld !== undefined) {
        resolve(tooOld)
        return
      }
      const exit = code !== null
        ? `exited with code ${code}`
        : `killed by signal ${signal ?? 'unknown'}`
      resolve(`${exit}${excerpt !== undefined ? `: ${excerpt}` : ''}`)
    })
  })
}

/** One rejected candidate with its single-line probe reason. */
export interface PythonProbeRejection {
  command: string
  reason: string
}

/**
 * Probe candidates in order and resolve the first working interpreter. A
 * command in `verified` skips probing (the caller caches successes; failures
 * are never cached, so an interpreter installed mid-session is picked up on
 * the next start). Rejects with one line naming every probed candidate and
 * its failure reason when none works.
 */
export async function resolvePythonCommand(
  candidates: readonly string[],
  options: { probeTimeoutMs: number; verified?: Set<string> },
): Promise<string> {
  const rejections: PythonProbeRejection[] = []
  for (const command of candidates) {
    if (options.verified?.has(command) === true) return command
    const reason = await probePythonInterpreter(command, options.probeTimeoutMs)
    if (reason === undefined) {
      options.verified?.add(command)
      return command
    }
    rejections.push({ command, reason })
  }
  throw new Error(
    'dsh-code-runtime-kernels: no working python interpreter found '
    + `(${rejections.map(rejection => `${rejection.command}: ${rejection.reason}`).join('; ')}); `
    + 'install a working python3 on PATH or set config.pythonPath',
  )
}
