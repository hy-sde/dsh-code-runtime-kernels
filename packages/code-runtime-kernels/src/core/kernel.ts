/**
 * Host-side driver for ONE persistent kernel subprocess, shared by the Python
 * and JavaScript/SDK runners (a `KernelRuntimeProfile` describes how to spawn
 * each). Owns the NDJSON wire: spawn + handshake, serialized outbound writes,
 * hostile-peer inbound parsing, binding-call dispatch, SIGINT interrupt with
 * SIGTERM/SIGKILL escalation, and shutdown-to-exit. This is process
 * confinement, not a security boundary: model code has bash-equivalent trust,
 * so the driver's job is robustness (a forged frame never crashes the host, an
 * unresponsive kernel is graded up to termination) rather than isolation.
 * @module @hy-sde-org/dsh-code-runtime-kernels/src/core/kernel
 */

import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CodeBindingNamespace, CodeJsonValue } from '@deepseek-ai/dsh-code-runtime'
import { snapshotJsonValue } from '@deepseek-ai/dsh-util-values'
import type { DoneFrame, KernelFrame, KernelHostMessage, SnapshotSpec } from './protocol.ts'
export type { DoneFrame, KernelFrame, KernelHostMessage, SnapshotSpec }

/** How to spawn and label one language's kernel. */
export interface KernelRuntimeProfile {
  /** The language descriptor this kernel presents (`'python'` | `'typescript'`). */
  key: string
  /** The interpreter/executable to spawn. */
  command: string
  /** argv placed before the runner argument. */
  argvPrefix: string[]
  /** Runner passed as the final argv (absolute path). */
  runnerPath?: string
  /** Runner embedded as source, staged to a scratch file and passed as argv. */
  stagedSource?: string
  /** File suffix for a staged runner (e.g. `.py`). */
  stagedSuffix?: string
  /** Extra environment variables for the subprocess. */
  env?: NodeJS.ProcessEnv
  /** Error-message prefix (`dsh-code-runtime-…`). */
  prefix: string
  /** Kernel id prefix (`py-` / `js-`). */
  idPrefix: string
  /** Human kernel label for messages (e.g. `python kernel`). */
  label: string
}

/** Per-kernel behavior knobs (validated + defaulted by the provider). */
export interface KernelStartConfig {
  /** Working directory for the subprocess. */
  cwd: string
  /** Environment to inherit (seam: model code has bash-equivalent trust). */
  env?: NodeJS.ProcessEnv
  /** How long to wait for the bootstrap `ready` frame. */
  startupTimeoutMs: number
  /** How long to wait after SIGINT before escalating to SIGTERM (then SIGKILL). */
  interruptEscalationMs: number
  /** Grace period for the kernel to exit after an `exit` frame before SIGTERM/SIGKILL. */
  shutdownGraceMs: number
  /**
   * Confinement wrapper applied to the fully-assembled argv (command +
   * argvPrefix + runner) just before spawn — e.g. the output of
   * {@link KernelSandboxProvider.confine} so the kernel launches under real
   * filesystem confinement (bwrap / landlock-run / seatbelt). Must fail
   * closed: a non-enforcing return is the provider's bug, not a fallback.
   * The wrapper becomes the process-group leader; the escalation ladder
   * unwinds through it.
   */
  confine?: (argv: readonly string[]) => { argv: string[] }
}

/**
 * The sandbox seam's confine capability, structurally typed (no runtime
 * dependency on `@deepseek-ai/dsh-sandbox`): wrap exact argv under a
 * file-effect policy, or fail closed. See the published seam for the contract.
 */
export interface KernelSandboxProvider {
  confine(
    argv: readonly string[],
    policy: { mode: 'read-only' | 'workspace-write'; workspaceRoot: string },
  ): { argv: string[] }
}

/** One in-flight run's host-side state. */
interface PendingRun {
  id: string
  namespaces: Map<string, CodeBindingNamespace>
  logs: Array<{ text: string; stream: string }>
  status: 'ok' | 'error'
  value?: CodeJsonValue
  executionCount?: number
  cancelled: boolean
  invalidOutput: boolean
  message: string
  killed: boolean
  done: Promise<void>
  finalize: () => void
}

/** The outcome of one kernel execution; budgets and kind mapping stay with the provider. */
export interface KernelExecResult {
  status: 'ok' | 'error'
  /** Captured program output, in order. */
  logs: Array<{ text: string; stream: string }>
  /** The completion value on a clean run with one. */
  value?: CodeJsonValue
  /** The session's execution count after this run. */
  executionCount?: number
  /** True when the run was interrupted or cancelled. */
  cancelled: boolean
  /** True when the completion was not lossless JSON. */
  invalidOutput: boolean
  /** Failure or protocol message, when any. */
  message: string
  /** True when the kernel had to be terminated to settle this run. */
  killed: boolean
}

/** The Node.js runner shipped as a package file (raw source in development, compiled ESM in the output). */
const RUNNER_PATH = fileURLToPath(new URL(
  new URL(import.meta.url).pathname.endsWith('.ts') ? '../nodejs/runner.ts' : '../nodejs/runner.js',
  import.meta.url,
))

/** Profile for the JavaScript kernel; `command` is the resolved node executable. */
export function nodejsKernelProfile(command: string): KernelRuntimeProfile {
  return {
    key: 'typescript',
    command,
    argvPrefix: ['--no-warnings'],
    runnerPath: RUNNER_PATH,
    prefix: 'dsh-code-runtime-kernels-nodejs',
    idPrefix: 'js-',
    label: 'nodejs kernel',
  }
}

/** Shared scratch root for staged runner scripts (inside the OS temp dir). */
const runnerDir = join(tmpdir(), 'dsh-kernels')

/** Render an unknown thrown value as a string, Error or not. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function tryMessageOf(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'message' in error) {
    return String(error.message)
  }
  return String(error)
}

/**
 * True when `pid` is safe to use as a process-group target for `kill(2)`.
 *
 * `process.kill(-pid, …)` is a group signal, and the degenerate targets are
 * catastrophic rather than merely useless: `-0` signals *our own* process group
 * (the host would kill itself along with the whole terminal job) and `-1`
 * signals every process the caller is permitted to signal. Both must be
 * rejected before the negation is applied. Ported from oh-my-pi
 * (`packages/coding-agent/src/eval/kernel-base.ts`), MIT.
 */
export function isSignalableProcessGroup(pid: number | undefined): pid is number {
  return typeof pid === 'number' && Number.isInteger(pid) && pid > 1
}

/**
 * Signal the whole process group led by `pid`, returning true when a signal
 * was actually delivered.
 *
 * Kernels are spawned with `detached: true` on POSIX (see the spawn options in
 * {@link KernelHost.startKernel}), so the runner becomes the leader of its own
 * session and process group. Signalling only the direct PID therefore leaves
 * anything the runner itself spawned behind, and those orphans keep the
 * kernel's pipes open for the remainder of the host's lifetime. This mirrors
 * the #7714 fix in oh-my-pi: sweep the whole group before falling back to
 * direct-PID escalation.
 *
 * Windows has no process groups, so this is a no-op there and callers keep
 * relying on the direct-PID kill.
 */
export function killProcessGroup(pid: number | undefined, signal: NodeJS.Signals): boolean {
  if (process.platform === 'win32') return false
  if (!isSignalableProcessGroup(pid)) return false
  try {
    process.kill(-pid, signal)
    return true
  } catch {
    // ESRCH: the group is already gone, which is the outcome we wanted anyway.
    // EPERM: not ours to signal. Neither is worth failing a shutdown over.
    return false
  }
}

/**
 * Distill a `done` frame into the failure taxonomy. A clean completion yields
 * `ok`; an invalid completion (not lossless JSON) yields `'invalid-output'`;
 * anything else is a program exception.
 */
export function doneFailure(frame: DoneFrame): { ok: true } | { ok: false; error: { kind: 'exception' | 'invalid-output'; message: string } } {
  if (frame.status === 'ok') return { ok: true }
  if (frame.invalidOutput === true) {
    return {
      ok: false,
      error: {
        kind: 'invalid-output',
        message: frame.message ?? 'program completion must be lossless JSON',
      },
    }
  }
  return { ok: false, error: { kind: 'exception', message: frame.message ?? 'program failed' } }
}

/**
 * Parse one kernel frame. The peer runs MODEL CODE and can emit anything, so
 * everything is re-validated and rebuilt field by field; junk returns
 * `undefined` and is dropped (a throw here would crash the host).
 */
export function parseKernelFrame(raw: unknown): KernelFrame | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const message = raw as Record<string, unknown>
  switch (message.type) {
    case 'ready': {
      if (typeof message.pid !== 'number') return undefined
      return { type: 'ready', pid: message.pid }
    }
    case 'started': {
      if (typeof message.id !== 'string') return undefined
      return { type: 'started', id: message.id }
    }
    case 'log': {
      if (typeof message.id !== 'string' || typeof message.text !== 'string') return undefined
      return { type: 'log', id: message.id, text: message.text, stream: typeof message.stream === 'string' ? message.stream : 'stdout' }
    }
    case 'call': {
      if (typeof message.id !== 'string' || typeof message.seq !== 'number'
        || typeof message.global !== 'string' || typeof message.name !== 'string') return undefined
      return {
        type: 'call', id: message.id, seq: message.seq, global: message.global, name: message.name,
        args: message.args as CodeJsonValue,
      }
    }
    case 'error': {
      if (typeof message.id !== 'string' || typeof message.ename !== 'string' || typeof message.evalue !== 'string') return undefined
      const traceback = Array.isArray(message.traceback)
        ? message.traceback.filter((entry): entry is string => typeof entry === 'string')
        : []
      return { type: 'error', id: message.id, ename: message.ename, evalue: message.evalue, traceback }
    }
    case 'done': {
      if (typeof message.id !== 'string') return undefined
      const frame: DoneFrame = { type: 'done', id: message.id, status: message.status === 'ok' ? 'ok' : 'error' }
      if (message.status === 'ok' && message.value !== undefined) frame.value = message.value as CodeJsonValue
      if (typeof message.executionCount === 'number') frame.executionCount = message.executionCount
      if (message.cancelled === true) frame.cancelled = true
      if (message.invalidOutput === true) frame.invalidOutput = true
      if (typeof message.message === 'string') frame.message = message.message
      return frame
    }
    default: return undefined
  }
}

/** One kernel subprocess, session-agnostic (the registry adds sessions). */
export class KernelHost {
  id: string
  pid: number | undefined
  readonly profile: KernelRuntimeProfile
  #proc: ChildProcess
  #stagedPath: string | undefined
  #writeChain: Promise<void> = Promise.resolve()
  #readBuffer = ''
  #runs = new Map<string, PendingRun>()
  #ready!: Promise<void>
  #settleReady!: () => void
  #exited: Promise<number>
  #alive = true
  #disposed = false
  #interruptEscalationMs: number
  #shutdownGraceMs: number

  /**
   * Spawn a kernel per the profile and wait for the bootstrap handshake.
   * Rejects on spawn failure, startup timeout, or an early process exit
   * (grading the fresh subprocess up to termination behind us).
   */
  static async start(profile: KernelRuntimeProfile, config: KernelStartConfig): Promise<KernelHost> {
    const argv: string[] = [...profile.argvPrefix]

    // A runner may be a shipped file, or embedded source staged to a scratch
    // file per spawn (tempdirs are shared host state; the embedded code may
    // change between versions). Only the staged variant touches the disk.
    let stagedPath: string | undefined
    if (profile.stagedSource !== undefined) {
      mkdirSync(runnerDir, { recursive: true })
      stagedPath = join(
        runnerDir,
        `runner-${process.pid}-${Math.random().toString(36).slice(2, 10)}${profile.stagedSuffix ?? ''}`,
      )
      try {
        writeFileSync(stagedPath, profile.stagedSource, 'utf8')
      } catch (error: unknown) {
        throw new Error(`${profile.prefix}: could not stage runner script: ${tryMessageOf(error)}`)
      }
    }
    const runnerArg = stagedPath ?? profile.runnerPath
    if (runnerArg !== undefined) argv.push(runnerArg)
    const fullArgv = [...argv]
    if (profile.command !== undefined) fullArgv.unshift(profile.command)

    // `--no-warnings` for the Node runner is statically safe: a development
    // spawn of the .ts kernel would otherwise leak the type-stripping
    // ExperimentalWarning into the captured stderr. Python gets unfiltered
    // stdout via -u plus PYTHONUNBUFFERED/PYTHONIOENCODING.
    // `detached: true` on POSIX calls setsid(2), making the runner a session
    // leader: anything it spawns stays in ITS process group, so a shutdown can
    // sweep the whole tree via killProcessGroup (the #7714 orphan fix) instead
    // of leaving grandchildren holding the kernel's pipes open.
    const wrapped: readonly string[] = config.confine !== undefined ? config.confine(fullArgv).argv : fullArgv
    const proc = spawn(wrapped[0] ?? profile.command, wrapped.slice(1), {
      cwd: config.cwd,
      env: { ...(config.env ?? process.env), ...profile.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
    })
    if (proc.pid === undefined) proc.unref()
    const kernel = new KernelHost(profile, stagedPath, proc, config)
    kernel.id = `${profile.idPrefix}${Math.random().toString(36).slice(2, 10)}`
    kernel.pid = proc.pid
    try {
      await Promise.race([
        kernel.#ready,
        // An early exit before the handshake must fail the start FAST (a
        // runner that cannot even boot — missing interpreter feature, syntax
        // error in a staged script — otherwise costs the full startup budget).
        kernel.#exited.then((code: number) => {
          throw new Error(`${profile.prefix}: kernel exited with code ${code} before becoming ready`)
        }),
        new Promise<never>((_resolve, reject) => {
          const timer = setTimeout(() => { reject(new Error(
            `${profile.prefix}: kernel did not become ready within ${config.startupTimeoutMs}ms`,
          )) }, config.startupTimeoutMs)
          timer.unref()
        }),
      ])
      return kernel
    } catch (error: unknown) {
      // An early exit already settled every in-flight run (none); a start
      // timeout must grade the half-booted subprocess up to termination.
      await kernel.killForFailedStart(typeof error === 'object' && error !== null
        ? tryMessageOf(error)
        : `${profile.label} startup failed`)
      throw error
    }
  }

  private constructor(
    profile: KernelRuntimeProfile,
    stagedPath: string | undefined,
    proc: ChildProcess,
    config: KernelStartConfig,
  ) {
    this.profile = profile
    this.id = ''
    this.#proc = proc
    this.#stagedPath = stagedPath
    this.#interruptEscalationMs = config.interruptEscalationMs
    this.#shutdownGraceMs = config.shutdownGraceMs
    proc.stdout?.setEncoding('utf8')
    proc.stderr?.setEncoding('utf8')
    proc.stdout?.on('data', (chunk: string) => { this.#ingest(chunk) })
    proc.stderr?.on('data', (chunk: string) => { this.#ingestStray(chunk) })
    this.#exited = new Promise<number>((resolve) => { proc.once('exit', (code) => { resolve(code ?? 0) }) })
    void this.#exited.then((code) => { this.#onProcessExit(code) })
    this.#ready = new Promise<void>((resolve) => { this.#settleReady = resolve })
  }

  /** The process is healthy and accepting runs. */
  isAlive(): boolean {
    return this.#alive && !this.#disposed
  }

  /**
   * Execute one program against the given namespaces. Kernel state persists
   * across calls, and only ONE exec may be in flight per kernel at a time —
   * the session registry serializes; callers must not overlap. Must be called
   * while {@link isAlive}. Resolves with a {@link KernelExecResult} whose
   * flags the provider maps onto the failure kinds.
   */
  async execute(
    id: string,
    code: string,
    namespaces: CodeBindingNamespace[],
    options: { signal?: AbortSignal; cwd?: string; env?: Record<string, string>; snapshot?: SnapshotSpec } = {},
  ): Promise<KernelExecResult> {
    if (!this.isAlive()) {
      return {
        status: 'error', logs: [], cancelled: false, invalidOutput: false,
        message: `${this.profile.label} is not running`, killed: true,
      }
    }
    const namespacesById = new Map<string, CodeBindingNamespace>()
    for (const namespace of namespaces) namespacesById.set(namespace.global, namespace)
    const run: PendingRun = {
      id,
      namespaces: namespacesById,
      logs: [],
      status: 'ok',
      cancelled: false,
      invalidOutput: false,
      message: '',
      killed: false,
      done: Promise.resolve(),
      finalize: () => {},
    }
    run.done = new Promise<void>((resolve) => { run.finalize = () => { resolve() } })
    this.#runs.set(id, run)
    const onAbort = (): void => { void this.#interrupt(run) }
    if (options.signal?.aborted) onAbort()
    else options.signal?.addEventListener('abort', onAbort, { once: true })

    try {
      const frame = {
        type: 'exec' as const,
        id,
        code,
        namespaces: namespaces.map(namespace => ({
          global: namespace.global,
          names: Object.keys(namespace.functions),
          ...namespace.errorClass ? { errorClass: namespace.errorClass } : {},
        })),
        ...options.cwd !== undefined ? { cwd: options.cwd } : {},
        ...options.env !== undefined ? { env: options.env } : {},
        ...options.snapshot !== undefined ? { snapshot: options.snapshot } : {},
      }
      await this.#write(frame)
      await run.done
    } finally {
      options.signal?.removeEventListener('abort', onAbort)
      this.#runs.delete(id)
    }
    return {
      ...this.#collect(run),
      ...run.value !== undefined ? { value: run.value } : {},
      ...run.executionCount !== undefined ? { executionCount: run.executionCount } : {},
    }
  }

  #collect(run: PendingRun): KernelExecResult {
    return {
      status: run.status,
      logs: run.logs,
      cancelled: run.cancelled,
      invalidOutput: run.invalidOutput,
      message: run.message,
      killed: run.killed,
    }
  }

  /** Request cancellation of the in-flight run via SIGINT, escalating to termination. */
  async interrupt(): Promise<void> {
    for (const run of [...this.#runs.values()]) await this.#interrupt(run)
  }

  #interrupt(run: PendingRun): Promise<void> {
    if (this.#disposed || !this.#alive) {
      run.cancelled = true
      run.message = 'kernel unavailable'
      run.killed = true
      run.finalize()
      return run.done
    }
    run.cancelled = true
    try {
      this.#proc.kill('SIGINT')
    } catch {
      /* process may already be gone */
    }
    // Escalate: the kernel may be stuck in code that ignores signals.
    const termTimer = setTimeout(() => {
      if (run.killed || !this.#alive) return
      try { this.#proc.kill('SIGTERM') } catch { /* gone */ }
      // The runner leads its own process group (detached spawn), so the
      // direct-PID signal never reaches anything it spawned. Sweep the group.
      killProcessGroup(this.#proc.pid, 'SIGTERM')
      const killTimer = setTimeout(() => {
        if (!run.killed) run.killed = true
        try { this.#proc.kill('SIGKILL') } catch { /* gone */ }
        // Always finish an attempted group shutdown with a SIGKILL sweep: the
        // leader exiting after SIGTERM does not prove its descendants did.
        killProcessGroup(this.#proc.pid, 'SIGKILL')
      }, this.#interruptEscalationMs)
      killTimer.unref()
      void run.done.then(() => { clearTimeout(killTimer) })
    }, this.#interruptEscalationMs)
    termTimer.unref()
    void run.done.then(() => { clearTimeout(termTimer) })
    return run.done
  }

  /** Gracefully shut down: `exit` frame, then SIGTERM, then SIGKILL; waits for exit. */
  async shutdown(): Promise<{ confirmed: boolean }> {
    if (this.#disposed) { await this.#whenExited() ; return { confirmed: true } }
    this.#alive = false
    this.#disposed = true
    for (const run of [...this.#runs.values()]) {
      run.cancelled = true
      run.killed = true
      run.message = 'kernel shutting down'
      run.finalize()
    }
    const exited = this.#exited
    await this.#write({ type: 'exit' }).catch(() => {})
    const grace = (): Promise<'timeout'> => new Promise<'timeout'>((resolve) => {
      const timer = setTimeout(() => { resolve('timeout') }, this.#shutdownGraceMs)
      timer.unref()
    })
    if (await Promise.race([exited.then(() => 'exited' as const), grace()]) === 'exited') return { confirmed: true }
    try { this.#proc.kill('SIGTERM') } catch { /* gone */ }
    // The runner leads its own process group (detached spawn), so the
    // direct-PID signal never reaches anything it spawned. Sweep the group too.
    killProcessGroup(this.#proc.pid, 'SIGTERM')
    if (await Promise.race([exited.then(() => 'exited' as const), grace()]) === 'exited') return { confirmed: true }
    try { this.#proc.kill('SIGKILL') } catch { /* gone */ }
    // The leader exiting after SIGTERM does not prove its descendants did.
    // Always finish an attempted group shutdown with a SIGKILL sweep.
    killProcessGroup(this.#proc.pid, 'SIGKILL')
    await exited.catch(() => {})
    return { confirmed: false }
  }
  /** Termination path for a startup that never completed. */
  private async killForFailedStart(_reason: string): Promise<void> {
    this.#alive = false
    this.#disposed = true
    try { this.#proc.kill('SIGTERM') } catch { /* gone */ }
    killProcessGroup(this.#proc.pid, 'SIGTERM')
    const timer = setTimeout(() => {
      try { this.#proc.kill('SIGKILL') } catch { /* gone */ }
      killProcessGroup(this.#proc.pid, 'SIGKILL')
    }, this.#shutdownGraceMs)
    timer.unref()
    await this.#exited.catch(() => {})
    clearTimeout(timer)
  }

  #onProcessExit(code: number): void {
    this.#alive = false
    // Finalize every still-registered run: an interrupt that had to escalate
    // to SIGKILL lands here, exactly like a spontaneous death. finalize is
    // idempotent, so a race with a `done` frame is harmless (the matching run
    // is removed from the map by execute()'s finally once its promise
    // resolves).
    for (const run of [...this.#runs.values()]) {
      run.status = 'error'
      run.message = `${this.profile.label} exited with code ${code} before completing`
      run.killed = true
      run.finalize()
    }
    // The staged scratch script has served its purpose; remove it once the
    // process is gone so the shared tempdir does not accumulate.
    if (this.#stagedPath !== undefined) {
      try { rmSync(this.#stagedPath) } catch { /* best effort */ }
      this.#stagedPath = undefined
    }
  }

  async #whenExited(): Promise<void> {
    await this.#exited.catch(() => {})
  }

  #ingestStray(text: string): void {
    if (text.length === 0) return
    for (const run of [...this.#runs.values()]) {
      if (!run.killed) run.logs.push({ text, stream: 'stderr' })
    }
  }

  #ingest(chunk: string): void {
    this.#readBuffer += chunk
    for (;;) {
      const nl = this.#readBuffer.indexOf('\n')
      if (nl < 0) break
      const line = this.#readBuffer.slice(0, nl)
      this.#readBuffer = this.#readBuffer.slice(nl + 1)
      if (!line.trim()) continue
      let raw: unknown
      try {
        raw = JSON.parse(line) as unknown
      } catch {
        continue
      }
      const frame = parseKernelFrame(raw)
      if (frame === undefined) continue
      this.#handleFrame(frame)
    }
  }

  #handleFrame(frame: KernelFrame): void {
    switch (frame.type) {
      case 'ready':
        this.#settleReady()
        return
      case 'started':
        return
      case 'log': {
        const run = this.#runs.get(frame.id)
        if (run !== undefined) run.logs.push({ text: frame.text, stream: frame.stream ?? 'stdout' })
        return
      }
      case 'call': {
        this.#dispatchCall(frame)
        return
      }
      case 'error': {
        const run = this.#runs.get(frame.id)
        if (run !== undefined) run.message = `${frame.ename}: ${frame.evalue}`
        return
      }
      case 'done': {
        const run = this.#runs.get(frame.id)
        if (run === undefined) return
        run.status = frame.status
        if (frame.value !== undefined) run.value = frame.value
        if (frame.executionCount !== undefined) run.executionCount = frame.executionCount
        if (frame.cancelled === true) run.cancelled = true
        if (frame.invalidOutput === true) run.invalidOutput = true
        if (frame.message !== undefined) run.message = frame.message
        run.finalize()
        return
      }
    }
  }

  #dispatchCall(frame: Extract<KernelFrame, { type: 'call' }>): void {
    const run = this.#runs.get(frame.id)
    if (run === undefined) {
      void this.#writeReply(frame.id, frame.seq, {
        ok: false,
        message: `no active run for id ${frame.id}`,
        name: frame.name,
      })
      return
    }
    // Own-property lookup only: a forged name like 'constructor' must not walk
    // the record's prototype chain and reach a callable the consumer never
    // declared. The provider validated namespaces, and the exec request names
    // them, so an unexpected member is a hostile-peer frame, answered, not a crash.
    const record = run.namespaces.get(frame.global)?.functions
    const fn = record !== undefined && Object.hasOwn(record, frame.name) ? record[frame.name] : undefined
    if (typeof fn !== 'function') {
      void this.#writeReply(frame.id, frame.seq, {
        ok: false,
        message: `unknown binding ${JSON.stringify(`${frame.global}.${frame.name}`)}`,
        name: frame.name,
      })
      return
    }
    void (async () => {
      try {
        const resolved = await fn(frame.args)
        let value: CodeJsonValue | undefined
        try {
          value = snapshotJsonValue(resolved)
        } catch {
          value = undefined
        }
        if (value === undefined) {
          await this.#writeReply(frame.id, frame.seq, {
            ok: false,
            message: 'binding resolution must be lossless JSON',
            name: frame.name,
          })
          return
        }
        await this.#writeReply(frame.id, frame.seq, { ok: true, value, name: frame.name })
      } catch (error: unknown) {
        await this.#writeReply(frame.id, frame.seq, {
          ok: false,
          message: messageOf(error),
          name: frame.name,
        })
      }
    })()
  }

  #writeReply(
    id: string,
    seq: number,
    payload: { ok: true; value: CodeJsonValue; name: string } | { ok: false; message: string; name: string },
  ): Promise<void> {
    const message: KernelHostMessage = payload.ok
      ? { type: 'reply', id, seq, ok: true, value: payload.value, name: payload.name }
      : { type: 'reply', id, seq, ok: false, message: payload.message, name: payload.name }
    return this.#write(message)
  }

  /** Serialized outbound write: lines never interleave even across await points. */
  #write(message: KernelHostMessage): Promise<void> {
    const next = this.#writeChain.then(() => new Promise<void>((resolve, reject) => {
      if (this.#proc.stdin === null || this.#proc.stdin.destroyed) {
        reject(new Error(`${this.profile.prefix}: kernel stdin closed`))
        return
      }
      this.#proc.stdin.write(`${JSON.stringify(message)}\n`, (error?: Error | null) => {
        if (error) reject(error)
        else resolve()
      })
    }))
    // Keep the chain from stalling forever on a single rejected write.
    this.#writeChain = next.catch(() => {})
    return next
  }
}

export { RUNNER_PATH }
