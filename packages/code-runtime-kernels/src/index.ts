/**
 * `run_kernel_code` — the persistent kernel tool for DeepSeek Harness,
 * self-contained (no upstream harness changes required, same as the sibling
 * dsh-tool-ast plugin). One long-lived `python3` or `node` subprocess per
 * `session` keeps state across calls; runs without a session are one-shot
 * (a fresh kernel spawning for exactly one program). The host driver, session
 * registry, and output ledger in `core/` are shared by both languages; each
 * language's runner program lives in `src/python` / `src/nodejs`.
 * This is process confinement, not a security boundary: model code has
 * bash-equivalent trust.
 * @module @hy-sde-org/dsh-code-runtime-kernels
 */

import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  DUNDER_MEMBER,
  PORTABLE_RESERVED_WORDS,
  RESERVED_BINDING_GLOBALS,
  RESERVED_ERROR_MEMBERS,
} from '@deepseek-ai/dsh-code-runtime'
import type {
  CodeBindingNamespace,
  CodeJsonValue,
  CodeRunFailure,
  CodeRunResult,
} from '@deepseek-ai/dsh-code-runtime'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { TerminalCallView, TerminalResultView, ToolResult } from '@deepseek-ai/dsh-tools'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { KernelHost, nodejsKernelProfile } from './core/kernel.ts'
import type { KernelExecResult } from './core/kernel.ts'
import { SessionRegistry } from './core/session.ts'
import { PYTHON_RUNNER } from './python/runner.ts'

/** Cordis plugin name for loader diagnostics. */
export const name = 'code-runtime-kernels'

/** Services this plugin requires: the tool registry and the system-prompt builder. */
export const inject = ['tools', 'systemPrompt'] as const

/**
 * Plugin config: which languages are enabled, and every execution cap
 * (changeable from any cordis.yml that mounts this plugin).
 */
export interface Config {
  /** Enabled languages; kernels of disabled languages are refused at call time. */
  languages?: ('python' | 'typescript')[]
  /** Explicit python executable. Defaults to `python3` on PATH (fails loud at first spawn when absent). */
  pythonPath?: string
  /** Explicit node executable. Defaults to `node` on PATH (fails loud at first spawn when absent). */
  nodePath?: string
  /** Cooperative tool-call timeout budget (ms) for `run_kernel_code` (default 30000). */
  toolTimeoutMs?: number
  /** Wall-clock ceiling per run: the backstop for a cell nothing can interrupt synchronously. */
  maxWallMs?: number
  /** Hard cap on combined serialized log-, completion-, and failure-message bytes. */
  maxOutputBytes?: number
  /** Reap a session idle for at least this many ms; `0` disables reaping. */
  sessionIdleMs?: number
  /** Wait after SIGINT before SIGTERM, then the same again before SIGKILL. */
  interruptEscalationMs?: number
  /** Wait for the bootstrap `ready` handshake before failing the kernel. */
  startupTimeoutMs?: number
  /** Grace period for the kernel to exit after an `exit` frame. */
  shutdownGraceMs?: number
}

/**
 * {@link Config} after schemastery fills the defaults: every number and the
 * `languages` list are resolved; `pythonPath`/`nodePath` stay optional (PATH
 * discovery). Used by {@link KernelManager} and typed as the validated shape
 * in `apply`.
 */
type ResolvedConfig = Required<Omit<Config, 'pythonPath' | 'nodePath'>> & Pick<Config, 'pythonPath' | 'nodePath'>

/** Schemastery schema for {@link Config}: defaults filled at load time. */
export const Config: z<Config> = z.object({
  languages: z.array(z.union(['python', 'typescript'] as const)).default(['python', 'typescript']),
  pythonPath: z.string(),
  nodePath: z.string(),
  toolTimeoutMs: z.number().default(30_000),
  maxWallMs: z.number().default(600_000),
  maxOutputBytes: z.number().default(67_108_864),
  sessionIdleMs: z.number().default(0),
  interruptEscalationMs: z.number().default(5_000),
  startupTimeoutMs: z.number().default(15_000),
  shutdownGraceMs: z.number().default(1_000),
})

/** Smallest cap that can represent the counted payloads: an empty logs array plus an empty JSON failure message. */
const MIN_OUTPUT_BYTES = 4

/** Constructor for a timeout-flavored abort reason, surfacing the budget in the result. */
class RunTimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TimeoutError'
  }
}

/** The language-portable identifier subset (see `CodeBindingNamespace.global`). */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/

/** One run request against the persistent kernels; `sessionId`/`reset` mirror the seam's persistence contract. */
export interface KernelRunRequest {
  /** Which kernel to run the program in (`'python'` presents as `language: python`, `'typescript'` as the SDK). */
  language: 'python' | 'typescript'
  /** The program source. Typescript runs as an async-function body (top-level `await`/`return` work); python runs as a module (top-level `await` works, the last expression is the value). */
  code: string
  /** Optional persistent-kernel identity: runs sharing one keep kernel state. */
  sessionId?: string
  /** Discard the session's prior kernel state before this run. */
  reset?: boolean
  /** Abort the run host-side; in-flight binding calls are the caller's to settle. */
  signal?: AbortSignal
  /** Optional host functions exposed to the program, one global object per namespace. */
  bindings?: CodeBindingNamespace[]
}

/**
 * The outcome vocabulary of `run_kernel_code` and {@link KernelManager.run}:
 * the code-execution seam's result envelope plus the session execution count
 * (upstream's `CodeRunResult` has no persistent-session fields, so this plugin
 * owns the additive `executionCount` surface).
 */
export type KernelRunResult = CodeRunResult & { executionCount?: number }

/**
 * Outer-output ledger for one run: admits log entries, the completion value,
 * and the failure message against one combined byte cap (same semantics as the
 * worker-thread backend's ledger — a value is a compact JSON serialization,
 * text is UTF-8 byte-counted).
 */
class OutputLedger {
  private bytes = 2 // JSON serialization of the empty logs array: []
  private entries = 0

  constructor(private readonly maxBytes: number) {}

  private textBytes(text: string): number {
    return Buffer.byteLength(text, 'utf8')
  }

  /** Admit one exact log entry, or report that the hard cap was crossed. */
  admit(text: string, sink: string[]): boolean {
    const separatorBytes = this.entries > 0 ? 1 : 0
    const stringBytes = this.textBytes(text)
    if (this.bytes + stringBytes + separatorBytes > this.maxBytes) return false
    this.bytes += stringBytes + separatorBytes
    this.entries += 1
    sink.push(text)
    return true
  }

  /** Finalize a successful absent-or-JSON completion against the combined cap. */
  success(logs: string[], value?: CodeJsonValue): CodeRunResult {
    if (value === undefined) return { logs }
    const valueBytes = this.compactJsonBytes(value)
    if (valueBytes === undefined || this.bytes + valueBytes > this.maxBytes) return this.limit(logs)
    return { logs, value }
  }

  /** Finalize a failure diagnostic, with output-limit taking precedence over the cap. */
  failure(logs: string[], error: CodeRunFailure): CodeRunResult {
    const messageBytes = this.textBytes(error.message)
    if (this.bytes + messageBytes <= this.maxBytes) return { logs, error }
    return this.limit(logs)
  }

  /** Build the explicit output-limit failure while retaining fitting logs. */
  limit(logs: string[]): CodeRunResult {
    const fullMessage = `outer output exceeded ${this.maxBytes} bytes`
    const messageBytes = this.textBytes(fullMessage)
    const retained: string[] = []
    let retainedBytes = 2
    for (const text of logs) {
      const separatorBytes = retained.length > 0 ? 1 : 0
      if (retainedBytes + this.textBytes(text) + separatorBytes + messageBytes > this.maxBytes) break
      retained.push(text)
      retainedBytes += this.textBytes(text) + separatorBytes
    }
    return { logs: retained, error: { kind: 'output-limit', message: fullMessage } }
  }

  private compactJsonBytes(value: CodeJsonValue): number | undefined {
    let text: string
    try {
      text = JSON.stringify(value)
    } catch {
      return undefined
    }
    return this.textBytes(text)
  }
}

/**
 * Owns the two persistent kernel registries and maps one `KernelRunRequest`
 * onto the same outcome vocabulary as the code-execution seam
 * (`CodeRunResult` + `CodeRunFailure` kinds), so programs behave like the
 * seam's persistent backends. Exported for programmatic use and the tests; the
 * model-facing surface is the `run_kernel_code` tool registered in `apply`.
 */
export class KernelManager {
  readonly #config: ResolvedConfig
  readonly #registries = new Map<'python' | 'typescript', SessionRegistry>()
  readonly #ledgerFactory: () => OutputLedger
  #disposed = false

  constructor(config: Config) {
    // Fill defaults here too: the plugin path gets them from the schemastery
    // schema, but programmatic callers (tests, tooling) may pass a partial
    // config and must get the same validated behavior.
    const resolved: ResolvedConfig = {
      languages: config.languages ?? ['python', 'typescript'],
      ...config.pythonPath !== undefined ? { pythonPath: config.pythonPath } : {},
      ...config.nodePath !== undefined ? { nodePath: config.nodePath } : {},
      toolTimeoutMs: config.toolTimeoutMs ?? 30_000,
      maxWallMs: config.maxWallMs ?? 600_000,
      maxOutputBytes: config.maxOutputBytes ?? 67_108_864,
      sessionIdleMs: config.sessionIdleMs ?? 0,
      interruptEscalationMs: config.interruptEscalationMs ?? 5_000,
      startupTimeoutMs: config.startupTimeoutMs ?? 15_000,
      shutdownGraceMs: config.shutdownGraceMs ?? 1_000,
    }
    const numericKeys = ['maxWallMs', 'maxOutputBytes', 'sessionIdleMs',
      'interruptEscalationMs', 'startupTimeoutMs', 'shutdownGraceMs'] as const
    for (const key of numericKeys) {
      const value = resolved[key]
      if (!(Number.isFinite(value) && value >= 0)) {
        throw new Error(`dsh-code-runtime-kernels: config.${key} must be a non-negative number, got ${String(value)}`)
      }
    }
    if (!Number.isSafeInteger(resolved.maxOutputBytes) || resolved.maxOutputBytes < MIN_OUTPUT_BYTES) {
      throw new Error(`dsh-code-runtime-kernels: config.maxOutputBytes must be a safe integer of at least ${MIN_OUTPUT_BYTES}`)
    }
    if (resolved.maxWallMs > MAX_TIMER_DELAY_MS) {
      throw new Error(`dsh-code-runtime-kernels: config.maxWallMs must be at most ${MAX_TIMER_DELAY_MS} (Node clamps a longer setTimeout delay to 1ms)`)
    }
    if (resolved.languages.length === 0) {
      throw new Error('dsh-code-runtime-kernels: config.languages must not be empty')
    }
    for (const language of resolved.languages) {
      if (language !== 'python' && language !== 'typescript') {
        throw new Error(`dsh-code-runtime-kernels: unknown language ${JSON.stringify(language)}`)
      }
    }
    this.#config = resolved
    this.#ledgerFactory = () => new OutputLedger(resolved.maxOutputBytes)
    for (const language of resolved.languages) {
      this.#registries.set(language, new SessionRegistry({
        label: language === 'python' ? 'python kernel' : 'nodejs kernel',
        start: () => this.#startKernel(language === 'python' ? 'python' : 'typescript'),
        sessionIdleMs: resolved.sessionIdleMs,
      }))
    }
  }

  /** Terminate every session kernel to quiescence (plugin teardown). */
  async teardown(): Promise<void> {
    this.#disposed = true
    await Promise.allSettled([...this.#registries.values()].map(registry => registry.disposeAll()))
  }

  /**
   * Execute one program. Program outcomes resolve with `error` as a result
   * field; the method rejects only for contract misuse (an unknown language, a
   * disposed manager, an invalid binding namespace). With a non-empty
   * `sessionId` the program runs in that session's persistent kernel and
   * `executionCount` is reported; `reset: true` discards prior state first.
   */
  async run(request: KernelRunRequest): Promise<KernelRunResult> {
    if (this.#disposed) throw new Error('dsh-code-runtime-kernels: run() after disposal')
    const registry = this.#registries.get(request.language)
    if (registry === undefined) {
      throw new Error(`dsh-code-runtime-kernels: language ${JSON.stringify(request.language)} not enabled (config.languages)`)
    }
    const bindings = this.validateBindings(request.bindings ?? [])
    if (request.signal?.aborted) {
      return this.#ledgerFactory().failure([], { kind: 'abort', message: String(request.signal.reason) })
    }

    // Wall-clock budget: this run's abort source. The kernel turns it into
    // SIGINT (and escalation), so a busy cell is interrupted hard.
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort(new RunTimeoutError(`wall-clock ceiling reached (${this.#config.maxWallMs}ms)`))
    }, this.#config.maxWallMs)
    timer.unref()
    const onOuter = (): void => { controller.abort(request.signal?.reason) }
    request.signal?.addEventListener('abort', onOuter, { once: true })

    try {
      const sessionId = request.sessionId
      const outcome: KernelExecResult = sessionId !== undefined && sessionId.length > 0
        ? await registry.executeOnSession(sessionId, request.code, bindings, {
          ...request.reset !== undefined ? { reset: request.reset } : {},
          signal: controller.signal,
        })
        : await this.#runOneShot(request.language, request.code, bindings, controller.signal)
      return this.finalize(outcome, timedOut)
    } finally {
      clearTimeout(timer)
      request.signal?.removeEventListener('abort', onOuter)
    }
  }

  #startKernel(language: 'python' | 'typescript'): Promise<KernelHost> {
    return language === 'python'
      ? this.#startPython()
      : this.#startNodejs()
  }

  #startPython(): Promise<KernelHost> {
    const profile = {
      key: 'python' as const,
      command: this.#config.pythonPath ?? 'python3',
      argvPrefix: ['-u'],
      stagedSource: PYTHON_RUNNER,
      stagedSuffix: '.py',
      env: {
        PYTHONUNBUFFERED: '1',
        PYTHONIOENCODING: 'utf-8',
        PYTHONDONTWRITEBYTECODE: '1',
        DSH_KERNEL_CWD: process.cwd(),
      },
      prefix: 'dsh-code-runtime-python',
      idPrefix: 'py-',
      label: 'python kernel',
    }
    return KernelHost.start(profile, this.#startConfig())
  }

  #startNodejs(): Promise<KernelHost> {
    return KernelHost.start(
      nodejsKernelProfile(this.#config.nodePath ?? 'node'),
      this.#startConfig(),
    )
  }

  #startConfig() {
    return {
      cwd: process.cwd(),
      env: process.env,
      startupTimeoutMs: this.#config.startupTimeoutMs,
      interruptEscalationMs: this.#config.interruptEscalationMs,
      shutdownGraceMs: this.#config.shutdownGraceMs,
    }
  }

  /** One fresh kernel for exactly one program: the one-shot path. */
  async #runOneShot(
    language: 'python' | 'typescript',
    code: string,
    bindings: CodeBindingNamespace[],
    signal: AbortSignal,
  ): Promise<KernelExecResult> {
    const kernel = await this.#startKernel(language)
    try {
      return await kernel.execute(randomUUID(), code, bindings, { signal })
    } catch (error: unknown) {
      return { status: 'error', logs: [], cancelled: false, invalidOutput: false, message: String(error), killed: false }
    } finally {
      await kernel.shutdown().catch(() => {})
    }
  }

  /**
   * Map a kernel outcome onto the failure taxonomy through the output ledger.
   * Budget expiry owns a run that hit the wall clock (whether or not the
   * kernel survived to acknowledge it); everything else interrupted is an
   * abort; a died kernel is an abort unless the budget already owns the run.
   */
  private finalize(outcome: KernelExecResult, timedOut: boolean): KernelRunResult {
    const ledger = this.#ledgerFactory()
    const logs = outcome.logs.map(entry => entry.text)
    if (timedOut) {
      const message = outcome.killed
        ? `wall-clock ceiling reached (${this.#config.maxWallMs}ms); kernel killed after unresponsive interrupt`
        : `wall-clock ceiling reached (${this.#config.maxWallMs}ms)`
      return ledger.failure(logs, { kind: 'timeout', message })
    }
    if (outcome.killed) {
      return ledger.failure(logs, { kind: 'abort', message: outcome.message || 'run interrupted' })
    }
    if (outcome.cancelled) {
      return ledger.failure(logs, { kind: 'abort', message: outcome.message || 'run interrupted' })
    }
    if (outcome.status === 'error') {
      if (outcome.invalidOutput) {
        return ledger.failure(logs, { kind: 'invalid-output', message: outcome.message || 'program completion must be lossless JSON' })
      }
      return ledger.failure(logs, { kind: 'exception', message: outcome.message || 'program failed' })
    }
    const result = outcome.value === undefined
      ? ledger.success(logs)
      : ledger.success(logs, outcome.value)
    return { ...result, ...outcome.executionCount !== undefined ? { executionCount: outcome.executionCount } : {} }
  }

  /** Reject malformed binding globals or typed-error declarations as contract misuse. */
  private validateBindings(bindings: CodeBindingNamespace[]): CodeBindingNamespace[] {
    const seen = new Map<string, CodeBindingNamespace>()
    for (const namespace of bindings) {
      if (!IDENTIFIER.test(namespace.global) || PORTABLE_RESERVED_WORDS.has(namespace.global)) {
        throw new Error(`dsh-code-runtime-kernels: binding global ${JSON.stringify(namespace.global)} is not a usable identifier`)
      }
      if (RESERVED_BINDING_GLOBALS.has(namespace.global) || seen.has(namespace.global)) {
        throw new Error(`dsh-code-runtime-kernels: reserved or duplicate binding global ${JSON.stringify(namespace.global)}`)
      }
      seen.set(namespace.global, namespace)
    }
    const errorClassNames = new Set<string>()
    for (const namespace of bindings) {
      const descriptor = namespace.errorClass
      if (descriptor === undefined) continue
      if (!IDENTIFIER.test(descriptor.name) || PORTABLE_RESERVED_WORDS.has(descriptor.name)) {
        throw new Error(`dsh-code-runtime-kernels: binding error class ${JSON.stringify(descriptor.name)} is not a usable identifier`)
      }
      if (RESERVED_BINDING_GLOBALS.has(descriptor.name) || seen.has(descriptor.name) || errorClassNames.has(descriptor.name)) {
        throw new Error(`dsh-code-runtime-kernels: reserved or duplicate injected global ${JSON.stringify(descriptor.name)}`)
      }
      const member = descriptor.memberNameProperty
      if (member.length === 0 || RESERVED_ERROR_MEMBERS.has(member) || DUNDER_MEMBER.test(member)) {
        throw new Error(`dsh-code-runtime-kernels: binding error member property ${JSON.stringify(descriptor.memberNameProperty)} is not usable`)
      }
      errorClassNames.add(descriptor.name)
    }
    return bindings
  }
}

/** Model-facing guide for when and how to use `run_kernel_code`. */
const TOOL_GUIDE = [
  'Prefer run_kernel_code to reading/writing scratch files when the work is computation with intermediate results',
  '— sessions keep kernel state (variables, imports, working data) across calls. Omit `session` for one-off',
  'computations; give related calls the same `session` id to carry state forward, and pass `reset: true` when',
  'the session\'s state is corrupted or unwanted. Python programs persist module-level variables; JavaScript',
  'programs persist via `state` and top-level assignments. A session reaps idle kernels after the configured',
  'timeout, so long-lived work should resume promptly or persist to disk.',
].join(' ')

/** Tool argument records and output value types for `run_kernel_code`. */
export interface RunKernelCodeArgs {
  language: 'python' | 'typescript'
  code: string
  session?: string
  reset?: boolean
}

/** The value `run_kernel_code` resolves: the seam's result envelope plus the execution count. */
export type RunKernelCodeValue = KernelRunResult

/** Render the result for the model: successful value, or the failure line. */
function renderResult(value: RunKernelCodeValue): string {
  const head: string[] = []
  if (value.error === undefined) {
    if (value.value !== undefined) head.push(`value: ${JSON.stringify(value.value)}`)
  } else {
    head.push(`${value.error.kind}: ${value.error.message}`)
  }
  if (value.logs.length > 0) {
    head.push('logs:', ...value.logs.map(log => `  ${log.replace(/\n/g, '\n  ')}`))
  }
  if (value.executionCount !== undefined) head.push(`execution_count: ${value.executionCount}`)
  return head.length > 0 ? head.join('\n') : '(no output)'
}

/** The persisted `presentationMeta` projection of one run result (a structurally-literal type so it stays JSON-value-assignable). */
export type RunKernelCodeMeta = {
  summary: string
  value?: CodeJsonValue
  error?: { kind: string; message: string }
  executionCount?: number
  logs: string[]
}

/** Project the durable, replayable presentation payload for a completed run. */
export function runKernelCodeMeta(value: RunKernelCodeValue): RunKernelCodeMeta {
  return {
    summary: value.error === undefined
      ? (value.value === undefined ? 'completed with no value' : 'completed')
      : 'failed',
    ...value.value !== undefined ? { value: value.value } : {},
    ...value.error !== undefined ? { error: { kind: value.error.kind, message: value.error.message } } : {},
    ...value.executionCount !== undefined ? { executionCount: value.executionCount } : {},
    logs: value.logs.slice(-20),
  }
}

/** Present a pending `run_kernel_code` call as a terminal card (a cell is a foreground command). */
export function presentRunKernelCodeCall(args: RunKernelCodeArgs): TerminalCallView {
  return {
    card: 'terminal',
    title: `run_kernel_code ${args.language}${args.session !== undefined ? ` [${args.session}]` : ''}: ${args.code.length > 120 ? `${args.code.slice(0, 120)}…` : args.code}`,
    ...args.reset === true ? { description: 'resets the session kernel first' } : {},
  }
}

/** Present a completed run from its persisted meta as a terminal card, or undefined on failure. */
export function presentRunKernelCodeResult(_args: RunKernelCodeArgs, result: ToolResult): TerminalResultView | undefined {
  if (result.isError) return undefined
  const meta = result.meta as RunKernelCodeMeta | undefined
  if (meta === undefined || !Array.isArray(meta.logs)) return undefined
  const parts: string[] = []
  if (meta.error !== undefined) parts.push(`${meta.error.kind}: ${meta.error.message}`)
  else if (meta.value !== undefined) parts.push(`value: ${JSON.stringify(meta.value)}`)
  if (meta.logs.length > 0) parts.push(...meta.logs)
  return {
    card: 'terminal',
    title: meta.summary,
    output: parts.join('\n'),
  }
}

/**
 * Cordis plugin `apply`: resolve config, own the kernel manager (disposed with
 * the plugin), and register `run_kernel_code` against `ctx.tools` so a plain
 * upstream harness exposes the persistent kernels with zero source changes.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const toolTimeoutMs = config.toolTimeoutMs ?? 30_000
  if (toolTimeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`dsh-code-runtime-kernels: config.toolTimeoutMs must be no greater than ${MAX_TIMER_DELAY_MS}`)
  }
  const manager = new KernelManager(config)
  ctx.effect(() => () => { void manager.teardown().catch(() => {}) })

  ctx.systemPrompt.section({
    name: 'tool:code-runtime-kernels',
    order: 106,
    text: TOOL_GUIDE,
  })

  const tool = defineTool({
    name: 'run_kernel_code',
    description: 'Execute model code in a persistent kernel and return its JSON completion '
      + 'and printed output. `language` picks the runtime: `python` or `typescript`. '
      + 'For `typescript` every cell runs as an async function body, so top-level '
      + '`await` and `return` work. For `python` a cell runs as a module: top-level '
      + '`await` works, statements persist into the session namespace, and the LAST '
      + 'expression is the completion value (a top-level `return` is invalid Python). ' 
      + 'Carry the same non-empty `session` across calls to keep kernel state (variables, '
      + 'imports, working data); omit it for a one-shot run in fresh state. Pass '
      + '`reset: true` to discard the session\'s prior kernel state before this run '
      + '(one reset instead of endless retries after state corruption).',
    parameters: {
      language: { type: 'string', enum: ['python', 'typescript'], required: true, description: 'Which runtime executes the code.' },
      code: { type: 'string', required: true, description: 'The program source. Runs as the body of an async function: top-level `await` and `return` are available; return a JSON value to surface it as the result value.' },
      session: { type: 'string', description: 'Optional persistent-kernel identity: runs sharing a session id keep kernel state. Omit for one-shot.' },
      reset: { type: 'boolean', description: 'Discard the session\'s prior kernel state (variables, imports) before this run. Costs one reset instead of many retries; requires `session` to be meaningful.' },
    },
    timeoutMs: toolTimeoutMs,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          value: { type: 'json', description: 'The program\'s completion value (JSON), when it returned one.' },
          logs: { type: 'array', items: { type: 'string' }, required: true, description: 'Program output lines, in emission order.' },
          executionCount: { type: 'integer', description: 'The session\'s execution count after this run (persistent sessions only).' },
          error: {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', enum: ['exception', 'timeout', 'abort', 'worker-exit', 'invalid-output', 'output-limit'], required: true, description: 'The failure class.' },
              message: { type: 'string', required: true, description: 'Model-feedable failure detail.' },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderResult(value as RunKernelCodeValue) }],
      presentationMeta: (_args, value) => runKernelCodeMeta(value as RunKernelCodeValue),
    },
    async execute(args: RunKernelCodeArgs, exec) {
      const result = await manager.run({
        language: args.language,
        code: args.code,
        ...args.session !== undefined ? { sessionId: args.session } : {},
        ...args.reset !== undefined ? { reset: args.reset } : {},
        signal: exec.signal,
      })
      return result
    },
    presentCall: presentRunKernelCodeCall,
    presentResult: presentRunKernelCodeResult,
  })
  ctx.tools.register(tool)
}

