/**
 * Per-line output clipping (config `maxOutputLineChars`): a single hostile
 * log line must not own the whole output budget, and the truncation marker
 * must be visible to the model.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { KernelManager } from '../src/index.ts'
import { cleanTempSnapshotDirs, tempSnapshotDir } from './test-util.ts'

function makeManager(overrides: Record<string, unknown> = {}): KernelManager {
  return new KernelManager({
    languages: ['python', 'typescript'],
    snapshotDir: tempSnapshotDir(),
    maxOutputLineChars: 40,
    ...overrides,
  })
}

afterEach(() => {
  cleanTempSnapshotDirs()
})

describe('per-line output cap', () => {
  it('clips long lines with a marker and keeps short lines intact', async () => {
    const manager = makeManager()
    try {
      const result = await manager.run({
        language: 'python',
        code: 'print("short")\nprint("A" * 200)\nprint("B" * 200)',
      })
      expect(result.error).toBeUndefined()
      const lines = result.logs.join('\n').split('\n')
      for (const line of lines) {
        expect(line.length).toBeLessThanOrEqual(40)
      }
      expect(result.logs.join('\n')).toContain('short')
      expect(result.logs.join('\n')).toContain('…')
    } finally {
      await manager.teardown()
    }
  })

  it('does not affect the completion value', async () => {
    const manager = makeManager()
    try {
      const result = await manager.run({ language: 'python', code: '123 + 1' })
      expect(result.error).toBeUndefined()
      expect(result.value).toBe(124)
    } finally {
      await manager.teardown()
    }
  })

  it('rejects out-of-range config values', async () => {
    expect(() => new KernelManager({ maxOutputLineChars: 2, snapshotDir: tempSnapshotDir() })).toThrow(/maxOutputLineChars/)
  })
})
