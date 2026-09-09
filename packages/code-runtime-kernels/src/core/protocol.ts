/**
 * Versionless, hostile-peer wire protocol shared by the persistent Node.js and Python kernels.
 * The host treats every kernel frame as forged (the peer runs MODEL CODE and
 * can emit anything); inbound frames are re-validated field by field before
 * use. The kernel-side reader is our co-shipped code and may trust host
 * messages, mirroring the worker-thread backend's asymmetry. Both
 * process-boundary kernels speak the same NDJSON shape, so the single host
 * driver in `kernel.ts` stays generic.
 * @module @hy-sde-org/dsh-code-runtime-kernels/src/core/protocol
 */

import type { CodeBindingErrorClass, CodeJsonValue } from '@deepseek-ai/dsh-code-runtime'

/** One binding global materialized inside the kernel for a run. */
export interface KernelNamespaceDescriptor {
  /** The program-visible global identifier (validated by the provider). */
  global: string
  /** The callable member names; functions themselves stay host-side. */
  names: string[]
  /** Optional typed-rejection contract (name + member-name property). */
  errorClass?: CodeBindingErrorClass
}

/**
 * Per-session namespace persistence. The kernel owns the file: it restores
 * once per process (on the first exec that carries a spec) and writes an
 * atomic snapshot after every successfully settled run, so state survives
 * kernel death, `reset`-adjacent crashes, and a full plugin restart. The host
 * may unlink the file (e.g. `reset`) — a missing file simply skips restore.
 */
export interface SnapshotSpec {
  /** Snapshot file path (kernel-owned temp-file+rename writes; host-owned delete). */
  path: string
  /** Combined serialized snapshot byte cap; entries beyond it are skipped by name. */
  maxBytes: number
  /** Per-entry byte cap; an entry larger than this is skipped and named. */
  maxEntryBytes: number
}

/** Host -> kernel: execute one program against this run's namespaces. */
export interface KernelExecMessage {
  type: 'exec'
  /** Run correlation id (a non-empty string, e.g. the session's run id). */
  id: string
  /** The program source, body-of-async-function semantics, kernel language. */
  code: string
  /** Binding globals to materialize for this run. */
  namespaces: KernelNamespaceDescriptor[]
  /** Optional working directory applied before execution. */
  cwd?: string
  /** Optional environment overrides applied before execution. */
  env?: Record<string, string>
  /** Optional namespace persistence for this session's kernel. */
  snapshot?: SnapshotSpec
}

/** Host -> kernel: the answer to one {@link KernelCallFrame}. */
export interface KernelReplyMessage {
  type: 'reply'
  id: string
  /** The call's correlation sequence, echoed from the frame. */
  seq: number
  ok: boolean
  /** The lossless-JSON resolution, present when `ok` is true. */
  value?: CodeJsonValue
  /** The rejection message, present when `ok` is false. */
  message?: string
  /** The rejected member name, surfaced onto the program-side error. */
  name?: string
}

/** Host -> kernel: graceful shutdown request. */
export interface KernelExitMessage {
  type: 'exit'
}

/** Every message the host sends. */
export type KernelHostMessage = KernelExecMessage | KernelReplyMessage | KernelExitMessage

/** Kernel -> host: the bootstrap handshake, emitted once at startup. */
export interface ReadyFrame {
  type: 'ready'
  pid: number
}

/** Kernel -> host: a run accepted the exec frame. */
export interface StartedFrame {
  type: 'started'
  id: string
}

/** Kernel -> host: captured program output for a run. */
export interface LogFrame {
  type: 'log'
  id: string
  text: string
  /** 'stdout' or 'stderr'; purely informational, both land in `logs`. */
  stream?: string
}

/** Kernel -> host: the program invoked one binding call. */
export interface CallFrame {
  type: 'call'
  id: string
  seq: number
  /** The namespace global the call targets. */
  global: string
  /** The member name within the namespace. */
  name: string
  /** The single argument, already lossless JSON. */
  args: CodeJsonValue
}

/** Kernel -> host: an uncaught program exception. */
export interface ErrorFrame {
  type: 'error'
  id: string
  ename: string
  evalue: string
  traceback: string[]
}

/**
 * Kernel -> host: the run settled. Program failures (exception, invalid
 * completion) land here as `status: 'error'`; budget/abort/substrate outcomes
 * are observed host-side (a cancelled run carries `cancelled: true`).
 */
export interface DoneFrame {
  type: 'done'
  id: string
  status: 'ok' | 'error'
  /** The lossless-JSON completion value, present on a clean run with one. */
  value?: CodeJsonValue
  /** The session's execution count after this run; informational. */
  executionCount?: number
  /** True when the host interrupted the run. */
  cancelled?: boolean
  /** True when the completion could not be represented as lossless JSON. */
  invalidOutput?: boolean
  /** The failure or protocol message, when any. */
  message?: string
}

/** Every frame the kernel sends. */
export type KernelFrame
  = ReadyFrame | StartedFrame | LogFrame | CallFrame | ErrorFrame | DoneFrame
