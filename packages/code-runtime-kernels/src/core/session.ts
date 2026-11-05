/**
 * Persistent-session registry, language-generic (shared by the Python and
 * JavaScript kernels). Maps a `sessionId` to one kernel whose namespace and
 * event-loop state survive every run in the session; on `reset` the old kernel
 * is shut down before a fresh one answers; at disposal every kernel is
 * terminated to quiescence. One exec at a time per session (a kernel
 * serializes stdin), so concurrent runs for the same session queue on a
 * per-session promise chain.
 * @module @hy-sde-org/dsh-code-runtime-kernels/src/core/session
 */

import { randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'
import type { PtcBindingNamespace } from '@deepseek-ai/dsh-ptc-runtime'
import type { KernelExecResult, KernelHost } from './kernel.ts'
import type { SnapshotSpec } from './protocol.ts'

/**
 * Thrown when a fresh kernel's preload (the configured "toolbox") failed to
 * settle; carries the preload run's result so the user's run surfaces a real
 * exception instead of a bare startup failure.
 */
class KernelPreloadError extends Error {
  constructor(readonly result: KernelExecResult) {
    super(result.message || 'kernel preload failed')
    this.name = 'KernelPreloadError'
  }
}

/** One live session: its kernel (spawned lazily) and the serialized run tail. */
interface KernelSession {
  kernel: KernelHost | null
  /** Tail of the per-session serialization chain (resolves to the last run). */
  queue: Promise<unknown>
  /** Admissions not yet settled; the idle deadline may fire only at 0. */
  pending: number
  /** Idle reaping timer, when configured. */
  idleTimer?: NodeJS.Timeout
}

/** Session-management knobs on top of the per-kernel start config. */
export interface SessionRegistryConfig {
  /** Label for error messages (e.g. `python kernel`). */
  label: string
  /** Spawn a fresh kernel for a newly acquired session (provider-resolved executable + timeouts). */
  start: (signal?: AbortSignal, sessionId?: string) => Promise<KernelHost>
  /** Reap a session whose kernel sits unused for this long; 0 disables. */
  sessionIdleMs: number
  /**
   * True when a caller-cancelled run leaves work still evaluating in the
   * kernel (the JavaScript runner's abandoned-cell ghost): the kernel is then
   * retired and awaited instead of reused, so the ghost cannot mutate state a
   * later run would see. Clean-cancellation kernels keep their kernel.
   */
  retireOnCancel?: boolean
  /**
   * Namespace persistence for one session: returns the spec every exec of the
   * session carries, or `undefined` when snapshots are disabled. A missing
   * function also disables snapshots.
   */
  snapshot?: (sessionId: string) => SnapshotSpec | undefined
  /**
   * Session "toolbox": runs once per fresh kernel, as a hidden first cell
   * BEFORE the session's snapshot is restored (so helpers are available, and
   * any restored name shadows a same-named helper — user state wins). Returns
   * the source to preload, or `undefined`/empty for none. A preload failure
   * fails the triggering run like an exception.
   */
  preload?: () => string | undefined
}

/** Options for one registered-session run. */
export interface SessionRunOptions {
  /** Discard prior kernel state and start fresh before this run. */
  reset?: boolean
  /** Abort source; SIGINT is raised inside the kernel on abort. */
  signal?: AbortSignal
  /** Per-run working directory override. */
  cwd?: string
  /** Per-run environment overrides. */
  env?: Record<string, string>
}

/**
 * Registers sessions and schedules every run onto its session's serialization
 * tail. A session kernel that died settling a run is retired (never reused,
 * never asked to re-run model code it died on — replaying would double
 * external effects); the next invocation starts on a fresh kernel. The idle
 * reap deadline is armed only while the session's queue is fully drained, so
 * a queued run can never be killed by the previous run's idle timer.
 */
export class SessionRegistry {
  readonly #sessions = new Map<string, KernelSession>()
  readonly #config: SessionRegistryConfig
  #disposed: boolean = false

  constructor(config: SessionRegistryConfig) {
    this.#config = config
  }

  /** Register (or return) the session for an id and run the work on its tail. */
  async executeOnSession(
    sessionId: string,
    code: string,
    bindings: PtcBindingNamespace[],
    options: SessionRunOptions = {},
  ): Promise<KernelExecResult> {
    if (this.#disposed) {
      return {
        status: 'error', logs: [], cancelled: false, invalidOutput: false,
        message: `${this.#config.label} session registry disposed`, killed: true,
      }
    }
    let session = this.#sessions.get(sessionId)
    if (session === undefined) {
      session = { kernel: null, queue: Promise.resolve(), pending: 0 }
      this.#sessions.set(sessionId, session)
    }
    // Admission marks the session busy; the idle deadline is rearmed only
    // when the LAST queued run settles (a timer armed by an earlier run's
    // finally would fire mid-execution of a later, still-pending run).
    const previousTail = session.queue
    session.pending += 1
    const task = previousTail.then(
      () => this.#settleRun(session, sessionId, code, bindings, options),
      () => this.#settleRun(session, sessionId, code, bindings, options),
    )
    // The chain tail never rejects: keep it flat for the next admission.
    session.queue = task.then(() => undefined, () => undefined)
    return (await task) as KernelExecResult
  }

  /** One admission, with the idle deadline rearmed only at queue drain. */
  async #settleRun(
    session: KernelSession,
    sessionId: string,
    code: string,
    bindings: PtcBindingNamespace[],
    options: SessionRunOptions,
  ): Promise<KernelExecResult> {
    try {
      return await this.#runOnSession(session, sessionId, code, bindings, options)
    } finally {
      session.pending -= 1
      if (session.pending <= 0) this.#maybeReap(sessionId)
    }
  }

  /** Shut down and drop one session's kernel. */
  async close(sessionId: string): Promise<void> {
    const session = this.#sessions.get(sessionId)
    if (session === undefined) return
    this.#sessions.delete(sessionId)
    clearTimeout(session.idleTimer)
    const kernel = session.kernel
    session.kernel = null
    if (kernel !== null) await kernel.shutdown().catch(() => {})
  }

  /** Terminate every kernel and drop every session (runtime disposal). */
  async disposeAll(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true
    const sessions = [...this.#sessions.values()]
    this.#sessions.clear()
    const kernels: KernelHost[] = []
    for (const session of sessions) {
      clearTimeout(session.idleTimer)
      if (session.kernel !== null) kernels.push(session.kernel)
      session.kernel = null
    }
    await Promise.allSettled(kernels.map(kernel => kernel.shutdown()))
  }

  #maybeReap(sessionId: string): void {
    if (this.#disposed) return
    if (this.#config.sessionIdleMs <= 0) return
    const session = this.#sessions.get(sessionId)
    if (session === undefined || session.kernel === null) return
    clearTimeout(session.idleTimer)
    session.idleTimer = setTimeout(() => {
      // Re-check at fire time: a run admitted after this deadline was armed
      // may still be executing, and close() must never kill it mid-run. The
      // deadline is only legitimate when the queue has drained again.
      if (this.#sessions.get(sessionId) !== session) return
      if (session.pending > 0) return
      if (session.kernel === null) return
      void this.close(sessionId)
    }, this.#config.sessionIdleMs)
    session.idleTimer.unref()
  }

  /**
   * Throw when the registry is already disposed. Reads the field fresh, so a
   * check after an await point cannot be narrowed away by an earlier one.
   */
  #assertNotDisposed(): void {
    if (this.#disposed) {
      throw new Error(`${this.#config.label} session registry disposed while acquiring kernel`)
    }
  }

  async #acquireKernel(sessionId: string, session: KernelSession, signal?: AbortSignal): Promise<KernelHost> {
    if (session.kernel !== null && session.kernel.isAlive()) return session.kernel
    const previous = session.kernel
    if (previous !== null) {
      await previous.shutdown().catch(() => {})
      session.kernel = null
    }
    this.#assertNotDisposed()
    if (this.#sessions.get(sessionId) !== session) {
      throw new Error(`${this.#config.label} session invalidated while acquiring kernel`)
    }
    const kernel = await this.#config.start(signal, sessionId)
    if (this.#disposed) {
      await kernel.shutdown().catch(() => {})
      this.#assertNotDisposed()
    }
    if (this.#sessions.get(sessionId) !== session) {
      await kernel.shutdown().catch(() => {})
      throw new Error(`${this.#config.label} session invalidated while acquiring kernel`)
    }
    session.kernel = kernel
    const preload = this.#config.preload?.()
    if (preload !== undefined && preload.length > 0) {
      // Hidden first cell: no snapshot spec, so the restore (and its notice)
      // still belongs to the user's first real exec. A failed preload must
      // not leave a half-configured kernel behind; fail the run instead.
      // The caller's abort signal applies to preload work too: an aborted
      // admission must not keep starting a kernel it will never use.
      const prepared = await kernel.execute(`preload-${randomUUID()}`, preload, [], signal !== undefined ? { signal } : {})
      if (prepared.status !== 'ok' || prepared.killed || prepared.cancelled) {
        await kernel.shutdown().catch(() => {})
        session.kernel = null
        throw new KernelPreloadError(prepared)
      }
    }
    return kernel
  }

  async #runOnSession(
    session: KernelSession,
    sessionId: string,
    code: string,
    bindings: PtcBindingNamespace[],
    options: SessionRunOptions,
  ): Promise<KernelExecResult> {
    // An aborted admission fails fast BEFORE any destructive reset work:
    // a caller that already gave up must not pay for a kernel shutdown +
    // snapshot delete it will never use.
    // (The abort check goes through a closure so the early-return below does
    // not narrow the signal for the rest of the function — the caller may
    // abort LATER, during the run, and the retire check must see that.)
    const callerAborted = (): boolean => options.signal?.aborted === true
    if (callerAborted()) {
      return {
        status: 'error', logs: [], cancelled: true, invalidOutput: false,
        message: 'run aborted before the kernel admitted it', killed: false,
      }
    }
    if (options.reset === true) {
      // Reset first, then acquire: prior kernel state is discarded and its
      // shutdown completes before the fresh kernel answers this run. The
      // snapshot is deleted between the two, so the fresh kernel must not
      // restore the state the reset just discarded.
      const previous = session.kernel
      if (previous !== null) {
        session.kernel = null
        clearTimeout(session.idleTimer)
        await previous.shutdown().catch(() => {})
      }
      // A snapshot we cannot discard would silently restore the state the
      // reset was meant to drop — fail the reset instead of certifying a
      // discard that did not happen.
      try {
        this.#deleteSnapshot(sessionId)
      } catch (error: unknown) {
        return {
          status: 'error', logs: [], cancelled: false, invalidOutput: false, killed: false,
          message: `reset aborted: the previous snapshot could not be discarded (${failureText(error)}); ` +
            'a later start may restore it — delete the snapshot file manually before retrying',
        }
      }
    }
    let kernel: KernelHost
    try {
      kernel = await this.#acquireKernel(sessionId, session, options.signal)
    } catch (error: unknown) {
      if (error instanceof KernelPreloadError) return error.result
      throw error
    }
    const first = await this.#executeOnce(kernel, sessionId, code, bindings, options)
    if (session !== this.#sessions.get(sessionId)) return first
    // Caller-abort on a kernel whose cancellation leaks (the JavaScript
    // runner's abandoned cell keeps evaluating as a ghost): retire the kernel
    // and AWAIT its shutdown so the ghost cannot mutate state a later run
    // would see. The next invocation starts fresh (restoring the last saved
    // snapshot, when snapshots are on).
    if (first.cancelled && callerAborted() && this.#config.retireOnCancel === true) {
      // Keep the registry entry: earlier admissions of this session are still
      // chained on THIS session object, and deleting the entry would make
      // their identity check reject ("session invalidated") without running.
      // `kernel = null` already forces the next invocation onto a fresh kernel.
      session.kernel = null
      await kernel.shutdown().catch(() => {})
      return first
    }
    // A kernel that died settling the run is retired — never reused, and the
    // run is NEVER retried: re-executing model code the caller did not ask to
    // re-run would double external effects (files appended twice, requests
    // duplicated). `crashed` lets the host surface the worker-exit warning;
    // the next invocation starts on a fresh kernel. The registry entry stays
    // (queued siblings keep their chain and pending count).
    if (first.killed || !kernel.isAlive()) {
      session.kernel = null
      await kernel.shutdown().catch(() => {})
      return first
    }
    return first
  }

  #executeOnce(
    kernel: KernelHost,
    sessionId: string,
    code: string,
    bindings: PtcBindingNamespace[],
    options: SessionRunOptions,
  ): Promise<KernelExecResult> {
    const snapshot = this.#config.snapshot?.(sessionId)
    return kernel.execute(sessionId, code, bindings, {
      ...options.signal !== undefined ? { signal: options.signal } : {},
      ...options.cwd !== undefined ? { cwd: options.cwd } : {},
      ...options.env !== undefined ? { env: options.env } : {},
      ...snapshot !== undefined ? { snapshot } : {},
    })
  }

  /**
   * Delete one session's snapshot file (missing is fine). A denied or failed
   * delete THROWS: the caller fails the reset run with a structured message
   * instead of certifying a discard that did not happen (a stale snapshot
   * would be silently restored by the very next start).
   */
  #deleteSnapshot(sessionId: string): void {
    const spec = this.#config.snapshot?.(sessionId)
    if (spec === undefined) return
    rmSync(spec.path, { force: true })
  }
}

/** One-line reason from an unknown throw site (no exported util here). */
function failureText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
