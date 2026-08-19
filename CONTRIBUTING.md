# Contributing

Thanks for helping with `dsh-code-runtime-kernels`. This is a small,
dependency-light monorepo; keep it that way.

## Ground rules

- **No new runtime dependencies** beyond `@deepseek-ai/schemastery` (schema
  validation), and no new `@deepseek-ai` dependencies beyond the declared
  peers. The kernels themselves live off the model's machine: Python uses only
  the standard library, JavaScript only Node builtins.
- **The kernels must stay standalone.** Never re-introduce the
  harness-internal `@deepseek-ai/dsh-code-runtime-*` implementations as source
  dependencies — the whole point is that this plugin works on stock deliveries
  of DeepSeek Harness. The standalone surface is `ctx.tools` and
  `ctx.systemPrompt`; subprocesses are spawned directly (process confinement,
  like the seam's own backends).
- **Both runners stay self-contained.** `src/python/runner.ts` is embedded
  source (stdlib only); `src/nodejs/runner.ts` is a compiled package file (Node
  builtins only). Neither may import other package sources.
- **Keep the host driver generic.** The shared `src/core/` driver is what makes
  "two providers, one core" real — a new language should add a runner + a small
  `KernelRuntimeProfile`, not fork `kernel.ts`.
- Preserve the per-file upstream attribution headers
  (`Ported from @oh-my-pi/...` — MIT, see `THIRD-PARTY-NOTICES.md`).

## Workflow

1. Make your change in `packages/code-runtime-kernels`.
2. `pnpm -r check` and `pnpm -r test` (real `python3`/`node` subprocess
   suites: session persistence, reset, budgets, bindings, hostile frames).
3. Add/extend a spec next to the behavior you changed.
4. `pnpm -r build`, then `bash scripts/release-public.sh --check`.
5. Open a PR against `main`.

## Releasing

Release authority lives with the maintainers. The flow is guarded by
`scripts/release-public.sh` (clean tree, checks, tests, build, pack, org
membership, absence check, interactive confirm) and publishes the single
package via `pnpm publish` so `workspace:*` specs are rewritten.
