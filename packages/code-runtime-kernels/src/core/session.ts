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
import type { CodeBindingNamespace } from '@deepseek-ai/dsh-code-runtime'
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
  /** Idle reaping timer, when configured. */
  idleTimer?: NodeJS.Timeout
}

/** Session-management knobs on top of the per-kernel start config. */
export interface SessionRegistryConfig {
  /** Label for error messages (e.g. `python kernel`). */
  label: string
  /** Spawn a fresh kernel for a newly acquired session (provider-resolved executable + timeouts). */
  start: () => Promise<KernelHost>
  /** Reap a session whose kernel sits unused for this long; 0 disables. */
  sessionIdleMs: number
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
 * tail. A session kernel that died mid-run (or was killed settling a prior
 * run) is replaced with a fresh one and the run retried once, like omp's
 * kernel-session registry — state loss on a hard kill is the accepted cost.
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
    bindings: CodeBindingNamespace[],
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
      session = { kernel: null, queue: Promise.resolve() }
      this.#sessions.set(sessionId, session)
    }
    const run = (): Promise<KernelExecResult> =>
      this.#runOnSession(session, sessionId, code, bindings, options)
    session.queue = session.queue.then(run, run)
    try {
      return (await session.queue) as KernelExecResult
    } finally {
      this.#maybeReap(sessionId)
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

  async #acquireKernel(sessionId: string, session: KernelSession): Promise<KernelHost> {
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
    const kernel = await this.#config.start()
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
      const prepared = await kernel.execute(`preload-${randomUUID()}`, preload, [], {})
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
    bindings: CodeBindingNamespace[],
    options: SessionRunOptions,
  ): Promise<KernelExecResult> {
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
      this.#deleteSnapshot(sessionId)
    }
    let kernel: KernelHost
    try {
      kernel = await this.#acquireKernel(sessionId, session)
    } catch (error: unknown) {
      if (error instanceof KernelPreloadError) return error.result
      throw error
    }
    const first = await this.#executeOnce(kernel, sessionId, code, bindings, options)
    // A kernel that died or was killed settling the run is replaced once and
    // the run retried; otherwise return what we got. A result that came back
    // `cancelled` with the caller still live and the kernel no longer alive is
    // the same dead-kernel case: the runner died settling the cancellation, so
    // a fresh kernel gets one retry (mirrors omp's dead-kernel recovery in
    // `kernel-session-registry.executeOnSession`).
    if (session !== this.#sessions.get(sessionId)) return first
    const dead = !kernel.isAlive()
    const cancelledButAlive = first.cancelled && !(options.signal?.aborted === true) && dead
    if (!first.killed && !cancelledButAlive) return first
    await kernel.shutdown().catch(() => {})
    if (session !== this.#sessions.get(sessionId)) return first
    try {
      kernel = await this.#acquireKernel(sessionId, session)
    } catch (error: unknown) {
      if (error instanceof KernelPreloadError) return error.result
      throw error
    }
    const second = await this.#executeOnce(kernel, sessionId, code, bindings, options)
    if (second.killed) {
      // Give up restoring state: report the second outcome with the first's
      // message so the caller sees that retries also died.
      return { ...second, message: second.message || first.message }
    }
    return second
  }

  #executeOnce(
    kernel: KernelHost,
    sessionId: string,
    code: string,
    bindings: CodeBindingNamespace[],
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

  /** Best-effort delete of one session's snapshot file (ignore missing/denied). */
  #deleteSnapshot(sessionId: string): void {
    const spec = this.#config.snapshot?.(sessionId)
    if (spec === undefined) return
    try {
      rmSync(spec.path, { force: true })
    } catch {
      // A failed delete leaves a stale snapshot: the kernel will restore it,
      // which is exactly the surprising outcome reset must prevent. Report by
      // name instead of certifying state was discarded.
      console.warn(`dsh-code-runtime-kernels: could not remove snapshot ${JSON.stringify(spec.path)} for session ${JSON.stringify(sessionId)}`)
    }
  }
}
