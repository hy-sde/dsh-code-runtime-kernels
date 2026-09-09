# Third-Party Notices

This project incorporates code derived from the following third-party
projects, under the terms of the MIT License. Each derived file carries the
attribution in its header; this notice aggregates the provenance.

## oh-my-pi

- **Project**: https://github.com/can1357/oh-my-pi (MIT License)
- **Copyright**: Copyright (c) 2025 Mario Zechner, Copyright (c) 2025-2026 Can Bölük

The persistent-eval-kernel concept and its kernel-session registry are ported
from `@oh-my-pi/pi-coding-agent`'s code-execution implementation onto the
DeepSeek Harness persistent-kernel contract:

- `packages/code-runtime-kernels/src/nodejs/runner.ts` — the JavaScript kernel
  runner (persistent `state` + global-object semantics, per-cell async-function
  body, binding bridge, SIGINT interrupt race) adapted from omp's JavaScript
  kernel.
- `packages/code-runtime-kernels/src/python/runner.ts` — the Python kernel
  runner (persistent namespace + asyncio loop, top-level await, binding proxy
  with typed error classes) adapted from omp's Python kernel.
- `packages/code-runtime-kernels/src/core/session.ts` — the session registry's
  serialize-queue and replace-and-retry-on-kill behavior mirrors omp's
  kernel-session registry.

## DeepSeek Harness

The implementation and tests are developed against the public DSH contracts
(`@deepseek-ai/*` on npm, MIT License), and the Node.js runner is authored to
run on stock Node.js with no dependence on harness internals. Harness
trademarks and the harness's own code remain the property of DeepSeek; this
project's ported and original portions retain their respective copyrights.

All other files in this repository are original to this project
(© 2026 hy-sde, MIT License).
