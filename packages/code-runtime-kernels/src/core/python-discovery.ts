/**
 * Python interpreter discovery and probing for kernel starts. Enumerates the
 * PATH (every match in PATH order, like omp's `$whichAll`) and probes each
 * candidate with a `-c` version check, so a broken shim on PATH falls through
 * to the next candidate instead of failing the kernel start.
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
 * PATH scan is the whole contract.
 */
export function whichAll(command: string, env: { PATH?: string } = process.env): string[] {
  const matches: string[] = []
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (dir === '') continue
    const candidate = join(dir, command)
    try {
      if (!statSync(candidate).isFile()) continue
      accessSync(candidate, constants.X_OK)
    } catch {
      continue
    }
    if (!matches.includes(candidate)) matches.push(candidate)
  }
  return matches
}

/**
 * Ordered python candidates for one resolution: an explicitly configured
 * interpreter first, then every `python` and every `python3` on PATH (each
 * list in PATH order; a `python` match is tried before a `python3` match at
 * the same precedence).
 */
export function enumeratePythonCandidates(configured: string | undefined, env: { PATH?: string } = process.env): string[] {
  return [
    ...configured !== undefined ? [configured] : [],
    ...whichAll('python', env),
    ...whichAll('python3', env),
  ]
}

/** The `-c` probe program: a python ≥3 asserts its major version and prints `MAJOR.MINOR.MICRO`. */
const PYTHON_PROBE_PROGRAM = "import sys; assert sys.version_info[0] >= 3; print('%d.%d.%d' % sys.version_info[:3])"

/** Probe stdout that proves the `-c` program ran on a python ≥3. */
const VERSION_REPORT = /^\d+\.\d+/

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
 * `undefined` when the interpreter works, or a single-line reason (spawn
 * error, non-zero exit, timeout, or a missing version report) otherwise.
 */
export async function probePythonInterpreter(command: string, timeoutMs: number): Promise<string | undefined> {
  const child = spawn(command, ['-c', PYTHON_PROBE_PROGRAM], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
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
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk })
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk })
    child.on('error', (error: Error) => {
      if (timedOut) return
      clearTimeout(timer)
      resolve(`spawn failed (${error.message})`)
    })
    child.on('close', (code: number | null, signal: string | null) => {
      if (timedOut) return
      clearTimeout(timer)
      if (timedOut) {
        resolve(`timed out after ${timeoutMs}ms`)
        return
      }
      if (code === 0 && VERSION_REPORT.test(stdout.trim())) {
        resolve(undefined)
        return
      }
      const excerpt = outputExcerpt(stderr) ?? outputExcerpt(stdout)
      if (code === 0) {
        resolve(`no version report${excerpt !== undefined ? ` (${excerpt})` : ''}`)
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
