# dsh-code-runtime-kernels

**Persistent Python + JavaScript kernels for DeepSeek Harness** — a standalone
plugin repo hosting ONE package,
[`@hy-sde-org/dsh-code-runtime-kernels`](./packages/code-runtime-kernels/), that
gives the model a first-class `run_kernel_code` tool with `session`/`reset`
state, execution counts, and both languages — with **zero upstream harness
changes** required.

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

Design decisions:
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

## Quick start

```bash
pnpm install
pnpm check     # tsc
pnpm test      # vitest — real python3/node subprocesses
pnpm build     # tsc → dist
bash scripts/release-public.sh --check
```

Mount the bundle (`@hy-sde-org/dsh-code-runtime-kernels` row from
`cordis.patch.yml`) into any deployment, and the model gets `run_kernel_code`.
Full docs in the [package README](./packages/code-runtime-kernels/README.md).

## License

MIT. Portions derived from
[oh-my-pi](https://github.com/can1357/oh-my-pi) (MIT, © 2025 Mario Zechner,
© 2025-2026 Can Bölük) — see
[THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md).
