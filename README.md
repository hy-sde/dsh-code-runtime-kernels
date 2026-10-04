<!-- MIRROR-NOTE:START -->
> [!NOTE]
> 📦 This plugin lives in the [**dsh-plugins**](https://github.com/hy-sde/dsh-plugins) monorepo — file issues & pull requests there.
> npm: [`@hy-sde-org/dsh-code-runtime-kernels`](https://www.npmjs.com/package/@hy-sde-org/dsh-code-runtime-kernels)
<!-- MIRROR-NOTE:END -->

# dsh-code-runtime-kernels — persistent code-execution kernels for DeepSeek Harness

**Persistent Python + JavaScript kernels for DeepSeek Harness** — a standalone
plugin repo hosting ONE package,
[`@hy-sde-org/dsh-code-runtime-kernels`](./packages/code-runtime-kernels/), that
gives the model a first-class `run_kernel_code` tool with `session`/`reset`
state, execution counts, and both languages — with **zero upstream harness
changes** required.

| Identity | Value |
| --- | --- |
| Package | `@hy-sde-org/dsh-code-runtime-kernels` |
| Plugin id | `hy-sde-kernels` — one self-contained row (the `hy-sde-` prefix avoids clashing with shipped row ids) |
| Seam | the `run_kernel_code` tool, registered on the host's `tools` service exactly like any shipped tool row |

> **Based on [oh-my-pi](https://github.com/can1357/oh-my-pi)** — the Python and
> JavaScript kernel runners and the kernel-session registry are adapted from
> oh-my-pi's code-execution implementation; the snapshot/restore design is
> informed by the MIT-licensed [pi-repl-py](https://github.com/k3-2o/pi-repl-py),
> reimplemented self-contained. See [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

## Why

Computation with intermediate results should not re-pay its setup on every
call. These kernels give the model session state that persists across calls —
and, via namespace snapshots, survives kernel death, idle reaping, and full
plugin restarts — while one shared host driver (`src/core/`) makes both
languages behave identically. It is process confinement, not a security
boundary, matching the harness's own `process` backends.

```
packages/code-runtime-kernels/
  src/
    core/           shared host driver: NDJSON protocol, `KernelHost`
                    (spawn+handshake, hostile-peer parsing, interrupt
                    escalation, shutdown), `SessionRegistry` (serialize,
                    reset, replace-and-retry), output ledger, binding
                    validation, invariant
    python/runner.ts   embedded self-contained Python kernel (stdlib only)
    nodejs/runner.ts   compiled self-contained Node.js kernel (builtins only)
    index.ts            plugin: config, KernelManager, run_kernel_code tool
  tests/            kernels.spec.ts + compile-error.spec.ts +
                    process-group.spec.ts + tool.spec.ts (real
                    subprocesses, 51 tests)
  cordis.patch.yml  the bundle row deployments mount
```

## Design decisions

- **One plugin, two providers, one core.** Both kernels share the driver in
  `src/core/`; each language contributes only its runner and a
  `KernelRuntimeProfile`. Adding a language means a runner + a profile, not a
  driver fork.
- **Own tool surface.** Upstream `run_code` cannot carry sessions, so this
  plugin owns `run_kernel_code(language, code, session?, reset?)` and reuses the
  seam's result vocabulary (`error.kind` of `exception`/`timeout`/`abort`/
  `worker-exit`/`invalid-output`/`output-limit`), exactly like the sibling
  [`dsh-tool-ast`](https://github.com/hy-sde/dsh-plugins/tree/main/dsh-tool-ast) owns `ast_grep`/
  `ast_edit`.
- **Snapshots, not just sessions.** Each successful run persists the session
  namespace (stdlib `pickle`/`marshal` on the Python side, V8 serialization on
  the Node side), and a fresh kernel restores it once — so state survives
  kernel death, idle reaping, and plugin restarts. Design informed by the
  MIT-licensed [`pi-repl-py`](https://github.com/k3-2o/pi-repl-py)'s
  snapshot/restore semantics (per-name loss reporting, atomic writes, honest
  reset notices), reimplemented self-contained.
- **Per-line output caps.** `maxOutputLineChars` clips a single log line with
  a `…` marker before it enters the result, so one hostile `repr` or log bomb
  cannot own the whole output budget as one line.
- **Preload toolbox.** `preload` runs one source per language as a hidden
  first cell of every fresh session kernel (before the snapshot restores), so
  sessions start with helpers — the same ergonomics as `pi-repl-py`'s helpers,
  layered on our snapshots.
- **Real IPython on demand.** `pythonImpl: 'ipykernel'` swaps the stdlib
  runner for a genuine `IPython` shell (magics, `!cmd`, display, top-level
  await) without touching the protocol, snapshots, or binding proxies — the
  "use the established kernel" option for Python, while the zero-dependency
  stdlib runner stays the default.
- **Optional sandbox-seam confinement.** `sandboxConfinement` routes every
  kernel spawn through the structural `confine` capability (the
  `@deepseek-ai/dsh-sandbox` `SandboxProvider` contract, no runtime
  dependency), wrapping the fully-assembled argv under bwrap/landlock-run/
  seatbelt — process-level file-effect confinement that fails closed.
- **Process confinement, not a security boundary**, matching the harness's own
  `process` backends.

## Prerequisites

- Node.js `^22.19.0 || >=24.0.0` (the package `engines` range) with npm and
  pnpm on `PATH`;
- `python3` and `node` interpreters — the runner spawns them (`pythonPath` /
  `nodePath`, PATH discovery by default) and fails loud at the first spawn
  when one is absent;
- DeepSeek Harness `0.2.0-rc.2` or newer, including the standard `dsh` CLI —
  the plugin mounts as an ordinary Cordis row, no upstream harness changes;
- optional: an interpreter with IPython installed for `pythonImpl:
  'ipykernel'`, and the `@deepseek-ai/dsh-sandbox` `confine` capability when
  `sandboxConfinement: true`.

Install the Harness CLI and pnpm before continuing:

```bash
npm install --global @deepseek-ai/dsh@0.2.0-rc.2 pnpm
dsh --version
```

## Quick start

### Route A — published npm package (recommended)

```bash
dsh plugin --profile web add @hy-sde-org/dsh-code-runtime-kernels
```

A bundle row ships (`cordis.patch.yml` inserts the `hy-sde-kernels` row), so
this single command mounts the plugin and the model gets `run_kernel_code`.

### Route B — from source (validate this checkout or hack on the plugin)

```bash
git clone git@github.com:hy-sde/dsh-plugins.git
cd dsh-plugins
pnpm install
pnpm --filter @hy-sde-org/dsh-code-runtime-kernels build

KERNELS_TGZ="$(cd dsh-code-runtime-kernels/packages/code-runtime-kernels && pnpm pack --pack-destination /tmp | tail -n 1)"
dsh plugin --profile web add "$KERNELS_TGZ"
```

`pnpm pack` runs the normal `prepack` build and produces a tarball containing
`dist/`. Full docs in the
[package README](./packages/code-runtime-kernels/README.md).

### Verify the composed configuration

```bash
dsh web --dump-config
```

The composed tree must show the `hy-sde-kernels` row loading
`@hy-sde-org/dsh-code-runtime-kernels`.

### Run

```bash
dsh web
```

Ask the model to run code with `run_kernel_code`: related calls sharing one
`session` id keep kernel state (variables, imports, working data), `reset:
true` discards a session's state, and a session reaped or killed resumes from
its snapshot on the next call with the same id.

### Uninstall

```bash
dsh plugin --profile web remove @hy-sde-org/dsh-code-runtime-kernels
```

Uninstalling removes the tool row; persisted snapshots under the configured
`snapshotDir` (default `~/.dsh/code-runtime-kernels/state`) stay on disk —
delete them separately if you want the state gone.

## Development

```bash
pnpm install
pnpm check     # tsc
pnpm test      # vitest — real python3/node subprocesses
pnpm build     # tsc → dist
bash scripts/release-public.sh --check
```

## License

MIT. Portions derived from
[oh-my-pi](https://github.com/can1357/oh-my-pi) (MIT, © 2025 Mario Zechner,
© 2025-2026 Can Bölük) — see
[THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md).
