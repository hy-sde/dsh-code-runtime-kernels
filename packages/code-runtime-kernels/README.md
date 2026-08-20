# @hy-sde-org/dsh-code-runtime-kernels

English | [中文](README.zh.md)

**Persistent Python and JavaScript kernels for DeepSeek Harness** — one self-contained plugin that gives the model a first-class `run_kernel_code` tool with session state that survives across calls. No upstream harness changes are required: it mounts as an ordinary Cordis plugin row (via `cordis.patch.yml`) and registers one tool on `ctx.tools`, exactly like the shipped tools.

Two long-lived kernel subprocesses share one host driver:

- **Python** — a long-lived `python3` subprocess running a [self-contained kernel](./src/python/runner.ts) (standard library only — no venv, no pip). Module-level variables and one asyncio event loop persist across cells; top-level `await` works; the last expression is the cell's value.
- **JavaScript** — a long-lived `node` subprocess running a [self-contained kernel](./src/nodejs/runner.ts) (Node builtins only). A persistent `state` object plus the process-global object carry values across cells; every cell runs as an async function body, so top-level `await` and `return` work; `return <json>` carries the completion value.

The wire protocol, kernel host driver (spawn + handshake, serialized writes, hostile-peer parsing, SIGINT with SIGTERM/SIGKILL escalation, shutdown-to-exit), session registry, binding validation, and output ledger are shared (`src/core/`), so both languages behave identically.

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
| `sessionIdleMs` | `0` | Reap a session whose kernel sits unused for this long (`0` disables; state loss is the explicit cost). |
| `interruptEscalationMs` | `5000` | Wait after SIGINT before SIGTERM, then the same again before SIGKILL. |
| `startupTimeoutMs` | `15000` | Wait for the bootstrap `ready` handshake before failing the kernel. |
| `shutdownGraceMs` | `1000` | Grace for the kernel to exit after an `exit` frame. |

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
- **Budgets and failure kinds.** Wall-clock expiry → `'timeout'`; cancellation or a kernel that had to die → `'abort'`; thrown exceptions → `'exception'`; non-JSON completions → `'invalid-output'`; combined output overflow → `'output-limit'`; kernel death → the session registry replaces the kernel and retries once. All are result FIELDS, never rejections of the tool.

## Model experience

The system-prompt guide tells the model to prefer `run_kernel_code` over scratch files for computation with intermediate results, to omit `session` for one-offs, to reuse a `session` id for related calls, and to pass `reset: true` when a session's state is corrupted or unwanted. The terminal card presentation shows language + session on each call and the captured output + failure line on completion.

## Known limitations

- **A busy synchronous cell resists SIGINT.** A `while (true) {}`/`while True:` loop never yields to the event loop, so the interrupt handler cannot run and the escalation ladder (SIGTERM then SIGKILL) is what actually stops it — costing the kernel's state, hence the session. Cells that yield (async `await` on timers/I/O/tool calls) cancel cleanly and the kernel survives (the wall-clock/timeout tests cover this split).
- **State can be poisoned.** A buggy program can corrupt the session's state at any time; `reset: true` is the intended recovery primitive.
- **No security boundary.** Kernel code has bash-equivalent trust, matching the harness's own process backends.
- **Idle kernels hold a process.** With `sessionIdleMs: 0` (default), session kernels stay alive until reset or plugin teardown, so long-lived work should resume promptly or persist to disk.

## Development

`pnpm check` (tsc), `pnpm test` (vitest; real `python3`/`node` subprocesses), `pnpm build` (tsc → ESModules under `dist/`), `pnpm pack` smoke. Layout: shared host driver in [`src/core/`](./src/core/) (protocol, kernel host, session registry, ledger), languages in [`src/python/runner.ts`](./src/python/runner.ts) (embedded source, staged per spawn) and [`src/nodejs/runner.ts`](./src/nodejs/runner.ts) (compiled file, spawned with `node --no-warnings`), the plugin/tool in [`src/index.ts`](./src/index.ts). Tests: [`tests/kernels.spec.ts`](./tests/kernels.spec.ts) drives both kernels through `KernelManager`; [`tests/tool.spec.ts`](./tests/tool.spec.ts) mounts the plugin on a real Cordis context and executes `run_kernel_code` through `ctx.tools.execute`.
