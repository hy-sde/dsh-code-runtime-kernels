# @hy-sde-org/dsh-code-runtime-kernels

English | [中文](README.zh.md)

**Persistent Python and JavaScript kernels for DeepSeek Harness** — one self-contained plugin that gives the model a first-class `run_kernel_code` tool with session state that survives across calls. No upstream harness changes are required: it mounts as an ordinary Cordis plugin row (via `cordis.patch.yml`) and registers one tool on `ctx.tools`, exactly like the shipped tools.

Two long-lived kernel subprocesses share one host driver:

- **Python** — a long-lived `python3` subprocess running a [self-contained kernel](./src/python/runner.ts) (standard library only — no venv, no pip). Module-level variables and one asyncio event loop persist across cells; top-level `await` works; the last expression is the cell's value.
- **JavaScript** — a long-lived `node` subprocess running a [self-contained kernel](./src/nodejs/runner.ts) (Node builtins only). A persistent `state` object plus the process-global object carry values across cells; every cell runs as an async function body, so top-level `await` and `return` work; `return <json>` carries the completion value.

The wire protocol, kernel host driver (spawn + handshake, serialized writes, hostile-peer parsing, SIGINT with SIGTERM/SIGKILL escalation, shutdown-to-exit), session registry, binding validation, and output ledger are shared (`src/core/`), so both languages behave identically.

**Namespace snapshots.** After every successfully settled run, the session's kernel namespace is snapshotted to disk (atomic temp-file-and-rename, per-entry + combined byte caps) and a fresh kernel for the session restores it once — so state survives a model cell that kills the kernel, an idle-reaped session, and a full plugin restart. The first run after a restore logs what was revived and what could not be (unpicklable entries are named, never silently dropped). `reset: true` deletes the snapshot so discarded state cannot sneak back; `snapshot: false` disables persistence entirely.

This is **process confinement, not a security boundary**: program source has bash-equivalent trust, exactly like the harness's own `process`-isolated backends. The driver's job is robustness — a forged frame never crashes the host, an unresponsive kernel is graded up to termination — not isolation.

## Mounting

Add the bundle row (or a similar row in any `cordis.yml`):

```yaml
- insert:
    - id: hy-sde-kernels
      name: '@hy-sde-org/dsh-code-runtime-kernels'
      config:
        languages: ['python', 'typescript']
        maxWallMs: 600000
        maxOutputBytes: 67108864
        sessionIdleMs: 0
        interruptEscalationMs: 5000
        startupTimeoutMs: 15000
        shutdownGraceMs: 1000
        toolTimeoutMs: 30000
```

All row ids carry the `hy-sde-` prefix so they never clash with shipped rows (a duplicate loader id fails the boot). Then the model sees the `run_kernel_code` tool.

## Config

| Key | Default | Meaning |
|---|---|---|
| `languages` | `['python', 'typescript']` | Enabled languages; a call to a disabled language is refused at call time. |
| `pythonPath` | `python3` | Explicit python executable (PATH discovery by default; fails loud at first spawn when absent). |
| `nodePath` | `node` | Explicit node executable (PATH discovery by default). |
| `toolTimeoutMs` | `30000` | Cooperative tool-call timeout (`exec.signal` becomes the per-run abort). |
| `maxWallMs` | `600000` | Per-run wall-clock budget; interrupt gradates SIGINT → SIGTERM → SIGKILL when the kernel does not respond. |
| `maxOutputBytes` | `67108864` | Combined serialized log-, completion-, and failure-message byte cap (an `'output-limit'` failure). |
| `maxOutputLineChars` | `4096` | Per-line output cap (chars): a longer line is clipped with a `…` marker so one log bomb cannot own the budget. |
| `sessionIdleMs` | `0` | Reap a session whose kernel sits unused for this long (`0` disables; state loss is the explicit cost). |
| `interruptEscalationMs` | `5000` | Wait after SIGINT before SIGTERM, then the same again before SIGKILL. |
| `startupTimeoutMs` | `15000` | Wait for the bootstrap `ready` handshake before failing the kernel. |
| `shutdownGraceMs` | `1000` | Grace for the kernel to exit after an `exit` frame. |
| `snapshot` | `true` | Namespace persistence: snapshot after each successful run, restore once on a fresh kernel. `false` disables. |
| `snapshotDir` | `~/.dsh/code-runtime-kernels/state` | Snapshot root; files live under `<language>/<session-id-hash>.snapshot`. |
| `snapshotMaxBytes` | `134217728` | Combined byte cap for one snapshot file; entries past it are skipped by name. |
| `snapshotMaxEntryBytes` | `8388608` | Per-entry byte cap; an entry larger than this is skipped and named. |
| `preload` | `{}` | Session "toolbox": `{ python?: string; typescript?: string }` sources run as one hidden first cell of every fresh session kernel (before the snapshot restores, so a restored name shadows a same-named helper). A preload failure fails the triggering run like an exception. |
| `pythonImpl` | `'stdlib'` | Python execution semantics: `stdlib` (self-contained runner) or `ipykernel` (a real IPython shell: magics, `!cmd`, display — the interpreter pointed at by `pythonPath` must have IPython installed; the kernel fails loud at boot otherwise). |
| `sandboxConfinement` | `false` | Route kernel subprocess spawns through the sandbox seam (structural `confine` capability, see `SandboxProvider` in `@deepseek-ai/dsh-sandbox`) instead of `spawn`ing the interpreter directly. |
| `sandboxProvider` | — | The confinement capability; required when `sandboxConfinement` is `true` (fail closed). |
| `sandboxWorkspaceRoot` | `process.cwd()` | Writable root under `workspace-write` confinement. |
| `sandboxMode` | `'workspace-write'` | File-effect mode for confined kernels (`'read-only'` or `'workspace-write'`). |

### Device setup for `ipykernel` mode

The runner does not bundle Python — it spawns `pythonPath`. To use
`pythonImpl: 'ipykernel'`, provision an interpreter with IPython once:

> `scripts/setup-ipykernel-venv.sh` (idempotent; re-run after a Python upgrade)

creates/refreshes `~/.dsh/venvs/code-runtime-kernels-python` (override the
paths with `DSH_KERNEL_VENV` / `DSH_KERNEL_BASE_PYTHON`), then point the
plugin row at it:

```yaml
- id: code-runtime-kernels
  name: '@hy-sde-org/dsh-code-runtime-kernels'
  config:
    pythonPath: /Users/<you>/.dsh/venvs/code-runtime-kernels-python/bin/python
    pythonImpl: 'ipykernel'
```

## Tool surface

`run_kernel_code` takes:

| Parameter | Meaning |
|---|---|
| `language` | `python` or `typescript`. |
| `code` | Program source: for `typescript` an async-function body (top-level `await`/`return` work); for `python` a module (top-level `await` works, the last expression is the completion value — a top-level `return` is invalid Python and is reported as an `exception`). |
| `session` | Optional non-empty id; calls sharing one id keep kernel state. Omit for a one-shot run in fresh state. |
| `reset` | Discard the session's prior kernel state before this run (one reset instead of many retries). |

It resolves the seam's result envelope — `value` (JSON completion), `logs`, `executionCount`, and `error { kind, message }` — so the vocabulary matches the harness's own `run_code` (`exception` / `timeout` / `abort` / `worker-exit` / `invalid-output` / `output-limit`), but with the persistent-session fields this plugin owns (`session`, `reset`, `executionCount`).

## Semantics

- **Sessions.** A call with a non-empty `session` runs in that session's kernel; `executionCount` reports the running count. `reset: true` shuts the old kernel down before a fresh one answers.
- **One-shot.** Without `session`, a fresh kernel is spawned, exactly one program runs, and the kernel is shut down.
- **Persistence.** Python: module-level variables and loop state survive across cells. JavaScript: `state` (a long-lived shared object) and sloppy-mode global assignments survive; `const`/`let`/`function`/`class` at cell top level are per-cell (async body), so persistent definitions go on `state`. A cell completes `return <json>` for a completion value, or with no `return` for a no-value run; non-lossless completions (cycles, `BigInt`, sets) are `'invalid-output'`.
- **Snapshots.** After each successful run the namespace is saved (Python: `pickle` + `marshal` for bytecode, per-name loss reporting; JavaScript: V8 binary serialization, so `Map`/`Set`/`Date`/cyclic values survive but function-valued keys are named as lost). A fresh kernel for the session restores the last snapshot once — the restoring run's logs carry `[dsh-kernels] restored N names from snapshot (could not restore: …)`. `reset: true` deletes the snapshot first, so it never resurrects discarded state. Python bytecode is `marshal`-format-dependent: restoring across a Python minor-version upgrade should be expected to lose function/class entries (named in the notice), not data.
- **Toolbox.** With `preload` set, every fresh session kernel runs the language's source as one hidden first cell before the snapshot restores: helpers behave like any other session state (they ride snapshots; a restored name shadows a same-named helper). Its output is hidden from the model; a preload failure fails the run it triggered.
- **Budgets and failure kinds.** Wall-clock expiry → `'timeout'`; cancellation or a kernel that had to die → `'abort'`; thrown exceptions → `'exception'`; non-JSON completions → `'invalid-output'`; combined output overflow → `'output-limit'`; kernel death → the session registry replaces the kernel and retries once. All are result FIELDS, never rejections of the tool.

## Model experience

The system-prompt guide tells the model to prefer `run_kernel_code` over scratch files for computation with intermediate results, to omit `session` for one-offs, to reuse a `session` id for related calls, and to pass `reset: true` when a session's state is corrupted or unwanted. The terminal card presentation shows language + session on each call and the captured output + failure line on completion.

## Known limitations

- **A busy synchronous cell resists SIGINT.** A `while (true) {}`/`while True:` loop never yields to the event loop, so the interrupt handler cannot run and the escalation ladder (SIGTERM then SIGKILL) is what actually stops it — costing the kernel's state, hence the session. Cells that yield (async `await` on timers/I/O/tool calls) cancel cleanly and the kernel survives (the wall-clock/timeout tests cover this split).
- **State can be poisoned.** A buggy program can corrupt the session's state at any time; `reset: true` is the intended recovery primitive (it also deletes the snapshot, so the corruption cannot come back).
- **No security boundary.** Kernel code has bash-equivalent trust, matching the harness's own process backends — and so do snapshot files (`pickle`/`marshal` are not safe to read from untrusted input). Keep `snapshotDir` user-private; a planted snapshot executes as the host.
- **Snapshot granularity is per-name.** Python: data, modules, importable callables, and `__main__`-defined functions/classes are saved by value; user-class instances, closures over non-picklables, and entries past the caps are named as lost on the next restore. JavaScript: `state` and sloppy-mode global assignments are saved per key; a function anywhere inside a key's value discards that whole key (named).
- **Snapshots are not free.** Each successful run pickles/serializes and writes the namespace. Large namespaces mean larger latencies; tune the caps (`snapshotMaxBytes`, `snapshotMaxEntryBytes`) or disable with `snapshot: false` if state is ephemeral.
- **Idle kernels hold a process.** With `sessionIdleMs: 0` (default), session kernels stay alive until reset or plugin teardown; a reaped session resumes from its snapshot on the next call with the same id.
- **`ipykernel` mode needs a real IPython.** Install `ipykernel` into the interpreter named by `pythonPath` (e.g. a venv) — the runner fails loud at boot with a clear message otherwise, and cells then run through the IPython shell (magics `%…`, `!cmd`, `display`), with snapshots and binding proxies working exactly as in stdlib mode.
- **Confinement binds snapshots to the workspace.** A confined kernel cannot write outside `sandboxWorkspaceRoot`, so `snapshotDir` must live under it (validated at construction; disable `snapshot` if the namespace is ephemeral). Confinement is process-level file-effect enforcement (bwrap / landlock-run / seatbelt via the seam), not a security boundary — model code still runs as your user.
- **TS preloads persist via `state`.** The TypeScript kernel evaluates each cell as an async-function body, so a `function`/`class` declaration in a preload stays cell-local; define toolbox helpers on `state` (e.g. `state.helper = …`).

## Development

`pnpm check` (tsc), `pnpm test` (vitest; real `python3`/`node` subprocesses), `pnpm build` (tsc → ESModules under `dist/`), `pnpm pack` smoke. Layout: shared host driver in [`src/core/`](./src/core/) (protocol, kernel host, session registry, ledger), languages in [`src/python/runner.ts`](./src/python/runner.ts) (embedded source, staged per spawn) and [`src/nodejs/runner.ts`](./src/nodejs/runner.ts) (compiled file, spawned with `node --no-warnings`), the plugin/tool in [`src/index.ts`](./src/index.ts). Tests: [`tests/kernels.spec.ts`](./tests/kernels.spec.ts) drives both kernels through `KernelManager`; [`tests/tool.spec.ts`](./tests/tool.spec.ts) mounts the plugin on a real Cordis context and executes `run_kernel_code` through `ctx.tools.execute`.
