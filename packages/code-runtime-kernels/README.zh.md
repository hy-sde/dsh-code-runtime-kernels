# @hy-sde-org/dsh-code-runtime-kernels

[English](README.md) | 中文

为 DeepSeek Harness 提供**持久化 Python 与 JavaScript 内核**——一个自包含插件，给模型一个一等公民的 `run_kernel_code` 工具，跨调用保留会话状态。无需改动上游 Harness：它以普通 Cordis 插件行（通过 `cordis.patch.yml`）挂载，并在 `ctx.tools` 上注册一个工具，与内置工具完全一致。

两个长期存活的 kernel 子进程共享同一个 host 驱动：

- **Python** —— 一个长寿命 `python3` 子进程，运行[自包含内核](./src/python/runner.ts)（仅标准库，无需 venv/pip）。模块级变量与一个 asyncio 事件循环跨 cell 保留；支持顶层 `await`；最后一个表达式即 cell 的值。
- **JavaScript** —— 一个长寿命 `node` 子进程，运行[自包含内核](./src/nodejs/runner.ts)（仅 Node 内置）。持久 `state` 对象与进程全局对象携带跨 cell 的值；每个 cell 以 async 函数体运行，支持顶层 `await`/`return`；`return <json>` 携带完成值。

线上协议、kernel host 驱动（spawn + 握手、串行写入、敌对对端解析、SIGINT→SIGTERM→SIGKILL 升级、退出握手）、会话注册表、绑定校验与输出账本全部共享（`src/core/`），两个语言的语义完全一致。

这是**进程隔离，而非安全边界**：程序源码拥有与内置 `process` 隔离后端相同的 bash 级信任。驱动的职责是健壮性——伪造帧不会弄崩 host，无响应的 kernel 会被逐步升级到终止——而非隔离。

## 挂载

在任意 `cordis.yml` 中添加 bundle 行（或类似行）：

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

所有行 id 带 `hy-sde-` 前缀以避免与内置行冲突（重复的 loader id 会导致启动失败）。随后模型即看到 `run_kernel_code` 工具。

## 配置

| 键 | 默认 | 含义 |
|---|---|---|
| `languages` | `['python', 'typescript']` | 启用的语言；调用未启用语言会被拒绝。 |
| `pythonPath` | `python3` | 显式 python 可执行文件（默认走 PATH 发现；缺失时首次 spawn 即失败）。 |
| `nodePath` | `node` | 显式 node 可执行文件（默认走 PATH 发现）。 |
| `toolTimeoutMs` | `30000` | 协作式工具调用超时（`exec.signal` 变为每次运行的 abort 源）。 |
| `maxWallMs` | `600000` | 每次运行的墙钟预算；中断按 SIGINT→SIGTERM→SIGKILL 升级。 |
| `maxOutputBytes` | `67108864` | 日志、完成值与失败消息合并后的字节上限（触发 `'output-limit'`）。 |
| `sessionIdleMs` | `0` | 空闲超过该毫秒数的会话被回收（`0` 禁用；状态丢失是显式代价）。 |
| `interruptEscalationMs` | `5000` | SIGINT 后等待再发 SIGTERM，再等同样时长发 SIGKILL。 |
| `startupTimeoutMs` | `15000` | 等待启动 `ready` 握手，超时判失败。 |
| `shutdownGraceMs` | `1000` | `exit` 帧后等待 kernel 退出的宽限期。 |

## 工具面

`run_kernel_code` 参数：

| 参数 | 含义 |
|---|---|
| `language` | `python` 或 `typescript`。 |
| `code` | 程序源码，作为 async 函数体执行（可用顶层 `await`/`return`）。 |
| `session` | 可选非空 id；相同 id 的调用共享 kernel 状态。省略则为一次性运行。 |
| `reset` | 本次运行前丢弃该会话的旧 kernel 状态（一次 reset 胜过无尽重试）。 |

返回 seam 的结果信封——`value`（JSON 完成值）、`logs`、`executionCount` 与 `error { kind, message }`——错误词汇与内置 `run_code` 一致（`exception` / `timeout` / `abort` / `worker-exit` / `invalid-output` / `output-limit`），但带有本插件自有的持久会话字段（`session`、`reset`、`executionCount`）。

## 语义

- **会话**。带非空 `session` 的调用运行于该会话的 kernel；`executionCount` 报告累计次数。`reset: true` 先关旧 kernel 再开新 kernel 响应。
- **一次性**。没有 `session` 时，spawn 一个新 kernel，恰好运行一个程序后关闭。
- **持久化**。Python：模块级变量与循环状态跨 cell 保留。JavaScript：`state`（长寿命共享对象）与 sloppy 全局赋值跨 cell 保留；cell 顶层的 `const`/`let`/`function`/`class` 是每 cell 作用域（async 函数体），持久定义请放 `state`。cell 以 `return <json>` 携带完成值，或以无 `return` 结束为无值运行；非 lossless JSON 完成值（环、`BigInt`、集合）判为 `'invalid-output'`。
- **预算与失败种类**。墙钟超时 → `'timeout'`；取消或被迫终止 → `'abort'`；抛异常 → `'exception'`；非 JSON 完成 → `'invalid-output'`；合并输出溢出 → `'output-limit'`；kernel 死亡 → 会话注册表替换 kernel 并重试一次。全部是结果字段，绝不会 reject 工具调用。

## 模型体验

系统提示引导模型：计算且含中间结果时优先 `run_kernel_code` 而非读写草稿文件；一次性计算省略 `session`；相关调用复用同一 `session` id；会话状态损坏或不需要时传 `reset: true`。终端卡片展示每次调用的语言 + 会话，以及完成后的捕获输出与失败行。

## 已知限制

- **同步忙循环抗拒 SIGINT**。`while (true) {}` / `while True:` 永不交还事件循环，中断处理器无法运行，实际由升级梯（SIGTERM 再 SIGKILL）终止——代价是会话状态与 kernel。会让出事件循环的 cell（对定时器/IO/工具调用的 `await`）可被干净取消，kernel 存活（墙钟/中止测试即覆盖这一分界）。
- **状态可能被污染**。错误程序随时可能弄坏会话状态；`reset: true` 是设计的恢复原语。
- **无安全边界**。kernel 代码拥有与内置 process 后端相同的 bash 级信任。
- **空闲 kernel 占用进程**。默认 `sessionIdleMs: 0` 下，会话 kernel 会存活到 reset 或插件卸载；长任务应尽快续跑或落盘。

## 开发

`pnpm check`（tsc）、`pnpm test`（vitest，真实 `python3`/`node` 子进程）、`pnpm build`（tsc → `dist/` 下的 ESM）、`pnpm pack` 冒烟。布局：共享 host 驱动在 [`src/core/`](./src/core/)（协议、kernel host、会话注册表、账本），各语言在 [`src/python/runner.ts`](./src/python/runner.ts)（内嵌源码，每次 spawn 落地为临时 `.py`）与 [`src/nodejs/runner.ts`](./src/nodejs/runner.ts)（编译产物，`node --no-warnings` 启动），插件与工具在 [`src/index.ts`](./src/index.ts)。测试：[`tests/kernels.spec.ts`](./tests/kernels.spec.ts) 通过 `KernelManager` 驱动双内核；[`tests/tool.spec.ts`](./tests/tool.spec.ts) 在真实 Cordis 上下文挂载插件并经 `ctx.tools.execute` 执行 `run_kernel_code`。
