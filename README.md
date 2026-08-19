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
  tests/            kernels.spec.ts + tool.spec.ts (real subprocesses,
                    36 tests)
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
  [`dsh-tool-ast`](https://github.com/hy-sde/dsh-tool-ast) owns `ast_grep`/
  `ast_edit`.
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
