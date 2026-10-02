/**
 * Kernel start fail-fast: a subprocess that exits before the bootstrap
 * `ready` handshake must reject the start immediately with the exit code,
 * instead of burning the whole startup timeout. Real subprocesses.
 */

import { describe, expect, it } from 'vitest'
import { KernelHost, nodejsKernelProfile } from '../src/core/kernel.ts'

describe('KernelHost.start — fail fast on early exit', () => {
  it('rejects with the exit code when the kernel dies before `ready`', { timeout: 20_000 }, async () => {
    // `/usr/bin/false` ignores its argv and exits 1 immediately: a stand-in
    // for a runner that cannot boot (missing interpreter feature, staged
    // script syntax error).
    const startedAt = Date.now()
    const error = await KernelHost.start(nodejsKernelProfile('/usr/bin/false'), {
      cwd: process.cwd(),
      startupTimeoutMs: 30_000,
      interruptEscalationMs: 5_000,
      shutdownGraceMs: 1_000,
    }).then(() => undefined, (error: unknown) => error)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('kernel exited with code 1 before becoming ready')
    // Far under the 30s startup budget: the exit races the handshake.
    expect(Date.now() - startedAt).toBeLessThan(10_000)
  })

  it('starts and handshakes a healthy kernel', async () => {
    const kernel = await KernelHost.start(nodejsKernelProfile(process.execPath), {
      cwd: process.cwd(),
      startupTimeoutMs: 15_000,
      interruptEscalationMs: 5_000,
      shutdownGraceMs: 1_000,
    })
    expect(kernel.isAlive()).toBe(true)
    await kernel.shutdown()
  })
})
