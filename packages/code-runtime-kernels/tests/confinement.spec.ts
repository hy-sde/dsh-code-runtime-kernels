/**
 * Sandbox-seam confinement (config `sandboxConfinement` + `sandboxProvider`):
 * the kernel's fully-assembled argv is wrapped through a structural
 * `confine` capability (the `@deepseek-ai/dsh-sandbox` provider contract), and
 * fail-closed config rules reject misconfiguration at construction time.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { KernelManager } from '../src/index.ts'
import { cleanTempSnapshotDirs, tempSnapshotDir } from './test-util.ts'

afterEach(() => {
  cleanTempSnapshotDirs()
})

describe('sandbox confinement', () => {
  it('wraps the kernel argv through the provider and still runs', async () => {
    const calls: Array<{ argv: string[]; mode: string; root: string }> = []
    const root = tempSnapshotDir()
    const provider = {
      confine: (argv: readonly string[], policy: { mode: string; workspaceRoot: string }) => {
        calls.push({ argv: [...argv], mode: policy.mode, root: policy.workspaceRoot })
        // Wrap through env(1) as a stand-in runner: the real provider wraps
        // via bwrap/landlock-run/seatbelt.
        return { argv: ['/usr/bin/env', ...argv] }
      },
    }
    const manager = new KernelManager({
      languages: ['python'],
      snapshotDir: `${root}/snap`,
      sandboxConfinement: true,
      sandboxProvider: provider,
      sandboxWorkspaceRoot: root,
    })
    try {
      const result = await manager.run({ language: 'python', sessionId: 'c', code: '1 + 1' })
      expect(result.error).toBeUndefined()
      expect(result.value).toBe(2)
      expect(calls.length).toBeGreaterThan(0)
      const first = calls[0]
      if (first !== undefined) {
        expect(first.mode).toBe('workspace-write')
        expect(first.root).toBe(root)
        // The full assembled argv (interpreter + flags + staged runner).
        expect(first.argv.join(' ')).toContain('python')
        expect(first.argv.some(arg => arg.endsWith('.py'))).toBe(true)
      }
    } finally {
      await manager.teardown()
    }
  })

  it('keeps the default mode workspace-write', async () => {
    let seen: string | undefined
    const root = tempSnapshotDir()
    const manager = new KernelManager({
      languages: ['python'],
      snapshotDir: `${root}/snap`,
      sandboxConfinement: true,
      sandboxProvider: {
        confine: (argv, policy) => {
          seen = policy.mode
          return { argv: ['/usr/bin/env', ...argv] }
        },
      },
      sandboxWorkspaceRoot: root,
    })
    try {
      await manager.run({ language: 'python', code: '1' })
      expect(seen).toBe('workspace-write')
    } finally {
      await manager.teardown()
    }
  })

  it('refuses confinement without a provider (fail closed)', () => {
    expect(() => new KernelManager({
      languages: ['python'],
      sandboxConfinement: true,
      snapshotDir: tempSnapshotDir(),
    })).toThrow(/sandboxProvider/)
  })

  it('refuses a snapshot dir outside the confined workspace root', () => {
    expect(() => new KernelManager({
      languages: ['python'],
      sandboxConfinement: true,
      sandboxProvider: { confine: argv => ({ argv: [...argv] }) },
      sandboxWorkspaceRoot: '/tmp/confined-root',
      snapshotDir: '/tmp/elsewhere-snap',
    })).toThrow(/snapshotDir/)
  })

  it('supports read-only mode', async () => {
    let seen: string | undefined
    const root = tempSnapshotDir()
    const manager = new KernelManager({
      languages: ['python'],
      snapshot: false,
      sandboxConfinement: true,
      sandboxMode: 'read-only',
      sandboxProvider: {
        confine: (argv, policy) => {
          seen = policy.mode
          return { argv: ['/usr/bin/env', ...argv] }
        },
      },
      sandboxWorkspaceRoot: root,
    })
    try {
      await manager.run({ language: 'python', code: '5' })
      expect(seen).toBe('read-only')
    } finally {
      await manager.teardown()
    }
  })
})
