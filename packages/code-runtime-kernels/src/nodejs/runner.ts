/**
 * The spawned Node.js kernel runner. One `node <this-file>` subprocess is one
 * persistent kernel: it owns the wire-protocol peers described in
 * `protocol.ts`, a persistent `state` object (plus the process-global object)
 * that survives every run of the session, and a per-run evaluation cell with
 * async-function-body semantics — top-level `await` and `return` work exactly
 * like the worker-thread backend, and bindings are materialized as ordinary
 * globals whose members bridge `call`/`reply` frames to the host.
 *
 * This file must stay self-contained (Node builtins only, no imports of other package
 * sources): tsc emits it as ESM under the package output and development tests
 * spawn the raw source directly (Node 22.18+/24+ runs erasable TypeScript).
 *
 * Persistence contract (mirrors the Python provider's user namespace):
 *  - `state` is a long-lived object exposed to every program; mutations
 *    survive until the session resets or the kernel exits.
 *  - sloppy-mode assignments like `x = 41` land on the process global and
 *    persist; `globalThis` itself persists.
 *  - `const`/`let`/`var`/`function`/`class` declared at cell top level are
 *    scoped to that cell (async-function body), exactly like a Node REPL
 *    line that uses top-level `await` — use `state` or the global object to
 *    persist values.
 * @module @hy-sde-org/dsh-code-runtime-kernels/src/nodejs/runner
 */

/** Host -> kernel messages this runner honors (see protocol.ts for the full contract). */
interface ExecNamespaceDescriptor {
  global: string
  names: string[]
  errorClass?: { name: string; memberNameProperty: string }
}
interface ExecMessage {
  type: 'exec'
  id: string
  code: string
  namespaces: ExecNamespaceDescriptor[]
  cwd?: string
  env?: Record<string, string>
}
interface ReplyMessage {
  type: 'reply'
  id: string
  seq: number
  ok: boolean
  value?: unknown
  message?: string
  name?: string
}
import { format } from 'node:util'
import { compileFunction } from 'node:vm'

/** Global-object accessor for program-scope globals keyed by identifier. */
const g: Record<string, unknown> = globalThis

/** The original stdout sink, captured before suppression of program writes. */
const rawStdout: NodeJS.WriteStream = process.stdout
const rawWrite: (chunk: string) => boolean = rawStdout.write.bind(rawStdout)

/** Emit one protocol frame (a single JSON line on stdout), untouched by the cap. */
function emit(frame: object): void {
  rawWrite(`${JSON.stringify(frame)}\n`)
}

// --- persistent kernel state -------------------------------------------------

/** Program-visible persistent state (survives every run in this kernel). */
const state: Record<string, unknown> = {}
let executionCount = 0

// --- per-run bookkeeping -----------------------------------------------------

interface PendingCall {
  reject: (error: Error) => void
  resolve: (value: unknown) => void
}

interface ActiveRun {
  id: string
  /** Binding-call replies keyed by their wire sequence. */
  calls: Map<number, PendingCall>
  /** Called on SIGINT to cancel the cell (settles the interrupt race). */
  interrupt: () => void
  /** Namespace globals materialized for this run, with the values they replaced. */
  restores: Array<[string, unknown]>
}

let active: ActiveRun | null = null

/** Emit a `log` frame into the active run's ledger; stray output is dropped. */
function logFrame(text: string, stream: string): void {
  if (active === null) return
  emit({ type: 'log', id: active.id, text, stream })
}

/** Patch the program's output surfaces into ordered per-run log frames. */
function installOutputCapture(): void {
  console.log = (...args: unknown[]) => { logFrame(format(...args) + '\n', 'stdout') }
  console.info = (...args: unknown[]) => { logFrame(format(...args) + '\n', 'stdout') }
  console.warn = (...args: unknown[]) => { logFrame(format(...args) + '\n', 'stderr') }
  console.error = (...args: unknown[]) => { logFrame(format(...args) + '\n', 'stderr') }
  console.debug = console.warn
  // Direct process.stdout.write is intentionally not patched (console.* and
  // process.stderr cover program output in practice); `emit` owns the wire.
  ;(process.stderr as { write: unknown }).write = (chunk: unknown) => { logFrame(String(chunk), 'stderr'); return true }
}

/** Render an unknown thrown value as a short error line. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Round-trip a completion through strict JSON; mirrors the Python lossless check. */
function losslessValue(value: unknown): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(JSON.stringify(value)) as unknown }
  } catch {
    return { ok: false }
  }
}

// --- tool bindings -----------------------------------------------------------

let nextCallSeq = 0

/** Wrap one callable member into an async bridge that awaits a host reply. */
function makeCallable(
  run: ActiveRun,
  gname: string,
  name: string,
  errorClass: { name: string; memberNameProperty: string } | undefined,
): (args: unknown) => Promise<unknown> {
  return async (args: unknown) => {
    const seq = ++nextCallSeq
    const pending = new Promise<unknown>((resolve, reject) => {
      run.calls.set(seq, { resolve, reject })
      emit({ type: 'call', id: run.id, seq, global: gname, name, args })
    })
    let value: unknown
    try {
      value = await pending
    } catch (error: unknown) {
      const message = messageOf(error)
      const nameForMember = errorClass !== undefined
        ? (error as { __dshMember?: string }).__dshMember ?? name
        : undefined
      const rejection = errorClass !== undefined
        ? new (g[errorClass.name] as new (message: string) => Error)(message)
        : new Error(message)
      if (errorClass !== undefined) {
        Object.assign(rejection, { [errorClass.memberNameProperty]: nameForMember })
      }
      throw rejection
    }
    return value
  }
}

// --- cell execution ----------------------------------------------------------

function materializeNamespaces(run: ActiveRun, namespaces: ExecNamespaceDescriptor[]): void {
  for (const descriptor of namespaces) {
    const previous = g[descriptor.global]
    run.restores.push([descriptor.global, previous])
    const record: Record<string, (args: unknown) => Promise<unknown>> = {}
    for (const name of descriptor.names) {
      record[name] = makeCallable(run, descriptor.global, name, descriptor.errorClass)
    }
    g[descriptor.global] = record
    if (descriptor.errorClass !== undefined) {
      const errorClassName = descriptor.errorClass.name
      const previousClass = g[errorClassName]
      run.restores.push([errorClassName, previousClass])
      g[errorClassName] = class extends Error {
        constructor(message: string) {
          super(message)
          this.name = errorClassName
        }
      }
      // The anonymous class has an empty `.name`; reflect the descriptor so
      // both `err.constructor.name` and `instanceof` read the real name.
      Object.defineProperty(g[errorClassName], 'name', { value: errorClassName })
    }
  }
}

function restoreGlobals(run: ActiveRun): void {
  for (const [name, previous] of run.restores) {
    if (previous === undefined) Reflect.deleteProperty(g, name)
    else g[name] = previous
  }
  run.restores.length = 0
}

/** The sentinel error that cancels a cell on SIGINT. */
const INTERRUPTED = new Error('run interrupted by SIGINT')
INTERRUPTED.name = 'INTERRUPTED'

/** Run one cell against this run's namespaces; settle the run when it finishes. */
async function runCell(code: string, run: ActiveRun, namespaces: ExecNamespaceDescriptor[]): Promise<void> {
  materializeNamespaces(run, namespaces)
  const interrupted = new Promise<never>((_resolve, reject) => { run.interrupt = () => { reject(INTERRUPTED) } })
  // Concatenation (not a template literal): the code is hostile user input and
  // may contain backticks or `${...}` without breaking the wrapper. This is the
  // kernel's core act — evaluation of model-written cells in a fresh wrapper.
  // Construction can itself throw (a cell with invalid JavaScript syntax);
  // that is a program error, not a reason to lose the kernel, so it settles
  // the run instead of letting the exception escape and kill the runner.
  let done = false
  const finish = (frame: object): void => {
    if (done) return
    done = true
    emit(frame)
  }
  let program: (...args: unknown[]) => unknown
  try {
    // `compileFunction` is V8's Function-constructor path without the implied-eval
    // surface: the same function-body semantics (including a `this` bound at
    // call time), compilable up front so a syntax error settles the run.
    program = compileFunction('return (async () => {\n' + code + '\n})()') as (...args: unknown[]) => unknown
  } catch (error: unknown) {
    const message = messageOf(error)
    emit({ type: 'error', id: run.id, ename: 'SyntaxError', evalue: message, traceback: [] })
    finish({ type: 'done', id: run.id, status: 'error', executionCount: ++executionCount, message })
    return
  }
  try {
    const promise = program.call(globalThis) as Promise<unknown>
    const value = await Promise.race([promise, interrupted])
    if (value === undefined) {
      // No completion value: `undefined` is the worker backend's convention for
      // a program that did not `return` anything, and the seam's value is optional.
      finish({ type: 'done', id: run.id, status: 'ok', executionCount: ++executionCount })
      return
    }
    const serialized = losslessValue(value)
    if (!serialized.ok) {
      finish({ type: 'done', id: run.id, status: 'error', executionCount: ++executionCount, invalidOutput: true, message: 'program completion must be lossless JSON' })
      return
    }
    finish({ type: 'done', id: run.id, status: 'ok', executionCount: ++executionCount, value: serialized.value })
  } catch (error: unknown) {
    if (error === INTERRUPTED) {
      finish({ type: 'done', id: run.id, status: 'error', cancelled: true, executionCount: ++executionCount })
      return
    }
    const message = messageOf(error)
    const stack = error instanceof Error && typeof error.stack === 'string' ? error.stack.split('\n') : []
    const ename = error instanceof Error ? error.name : 'Error'
    emit({ type: 'error', id: run.id, ename, evalue: message, traceback: stack })
    finish({ type: 'done', id: run.id, status: 'error', executionCount: ++executionCount, message })
  } finally {
    restoreGlobals(run)
  }
}

// --- wire loop ---------------------------------------------------------------

let readBuffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk: string) => {
  readBuffer += chunk
  for (;;) {
    const nl = readBuffer.indexOf('\n')
    if (nl < 0) break
    const line = readBuffer.slice(0, nl)
    readBuffer = readBuffer.slice(nl + 1)
    if (!line.trim()) continue
    let message: unknown
    try {
      message = JSON.parse(line) as unknown
    } catch {
      continue
    }
    void handleMessage(message)
  }
})

async function handleMessage(raw: unknown): Promise<void> {
  if (raw === null || typeof raw !== 'object') return
  const message = raw as Partial<Record<string, unknown>>
  switch (message.type) {
    case 'exec':
      await handleExec(message as unknown as ExecMessage)
      break
    case 'reply':
      handleReply(message as unknown as ReplyMessage)
      break
    case 'exit':
      process.exit(0)
  }
}

function handleReply(message: ReplyMessage): void {
  if (active === null) return
  const call = active.calls.get(message.seq)
  if (call === undefined) return
  active.calls.delete(message.seq)
  if (message.ok) call.resolve(message.value)
  else {
    const error = Object.assign(new Error(message.message ?? 'binding failed'), { __dshMember: message.name })
    call.reject(error)
  }
}

async function handleExec(message: ExecMessage): Promise<void> {
  if (typeof message.id !== 'string' || message.id.length === 0) return
  if (typeof message.code !== 'string') {
    emit({ type: 'error', id: message.id, ename: 'ProtocolError', evalue: 'code must be a string', traceback: [] })
    emit({ type: 'done', id: message.id, status: 'error', executionCount: ++executionCount, message: 'code must be a string' })
    return
  }
  if (typeof message.cwd === 'string') {
    try { process.chdir(message.cwd) } catch { /* keep previous cwd */ }
  }
  if (message.env !== undefined && typeof message.env === 'object') {
    for (const [key, value] of Object.entries(message.env)) {
      if (typeof value === 'string') process.env[key] = value
      else Reflect.deleteProperty(process.env, key)
    }
  }
  const namespaces = Array.isArray(message.namespaces) ? message.namespaces : []
  const run: ActiveRun = {
    id: message.id,
    calls: new Map(),
    interrupt: () => { /* installed by runCell */ },
    restores: [],
  }
  active = run
  emit({ type: 'started', id: run.id })
  await runCell(message.code, run, namespaces)
  // The run settled (normally, failed, or interrupted); a cancelled cell's
  // ghost keeps evaluating in the background, so later runs must not see it.
  if (active === run) active = null
}

// --- signals -----------------------------------------------------------------

/** SIGINT cancels the active run. A busy synchronous cell blocks the event
 *  loop here, so the host's escalation ladder (SIGTERM then SIGKILL) is what
 *  actually stops it — the same outcome, owned by the host. */
process.on('SIGINT', () => {
  if (active !== null) active.interrupt()
})

// --- boot --------------------------------------------------------------------

// The program cells evaluate through `new Function` in the process global
// scope; the persistent `state` object is exposed there so runs can share it.
g.state = state
installOutputCapture()
emit({ type: 'ready', pid: process.pid })
