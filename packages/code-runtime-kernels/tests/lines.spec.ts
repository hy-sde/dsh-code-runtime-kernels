/**
 * Byte-level frame-line splitting (omp 69580d44c0 / #14704): the kernel host
 * reads the runner's stdout through a LineSplitter instead of string
 * accumulation + per-chunk tail-joins, so appending N chunks costs O(total
 * bytes) rather than re-copying the buffered prefix per chunk. Lines decode
 * only once complete (multibyte-safe: a UTF-8 sequence never contains a line
 * break), own their bytes, and a trailing unterminated line at stream end is
 * still parsed. The second block pins the host loop end-to-end over a real
 * subprocess: an invalid JSON line warns with a 200-char preview and never
 * wedges the frame channel.
 */

import { Buffer } from 'node:buffer'
import { describe, expect, it, vi } from 'vitest'
import { KernelHost, nodejsKernelProfile } from '../src/core/kernel.ts'
import { LineSplitter } from '../src/core/lines.ts'

function bytes(text: string): Uint8Array {
  return Buffer.from(text, 'utf8')
}

describe('LineSplitter', () => {
  it('splits complete lines and excludes terminators', () => {
    const splitter = new LineSplitter()
    expect(splitter.push(bytes('{"a":1}\n{"b":2}\n'))).toEqual(['{"a":1}', '{"b":2}'])
    expect(splitter.flush()).toBeUndefined()
  })

  it('decodes a multibyte character split across chunks', () => {
    const splitter = new LineSplitter()
    const whole = bytes('{"v":"héllo"}\n') // é is two bytes, cut between them
    const first = splitter.push(whole.subarray(0, 8))
    const second = splitter.push(whole.subarray(8))
    expect([...first, ...second]).toEqual(['{"v":"héllo"}'])
  })

  it('yields blank lines for the caller to skip', () => {
    const splitter = new LineSplitter()
    expect(splitter.push(bytes('\n\nx\n'))).toEqual(['', '', 'x'])
  })

  it('buffers a partial line until its terminator arrives', () => {
    const splitter = new LineSplitter()
    expect(splitter.push(bytes('par'))).toEqual([])
    expect(splitter.push(bytes('tial\nmore'))).toEqual(['partial'])
    expect(splitter.flush()).toBe('more')
    expect(splitter.flush()).toBeUndefined()
  })

  it('returns owned lines: later chunk mutation cannot change them', () => {
    const splitter = new LineSplitter()
    const chunk = bytes('{"a":1}\n')
    const [line] = splitter.push(chunk)
    chunk.fill(0)
    expect(line).toBe('{"a":1}')
  })

  it('splits a frame far beyond one chunk', () => {
    const splitter = new LineSplitter()
    const big = 'x'.repeat(2 * 1024 * 1024)
    const payload = bytes(`${big}\n`)
    const lines: string[] = []
    for (let offset = 0; offset < payload.length; offset += 8192) {
      lines.push(...splitter.push(payload.subarray(offset, offset + 8192)))
    }
    expect(lines).toEqual([big])
  })
})

/**
 * A stand-in runner that pollutes the frame channel with an invalid JSON line
 * before the handshake, then answers execs normally — the host must warn on
 * the garbage line and keep serving frames.
 */
const INVALID_FRAME_RUNNER = `
process.stdout.write('not-json-frame-with-' + 'y'.repeat(220) + '\\n')
process.stdout.write(JSON.stringify({ type: 'ready', pid: process.pid }) + '\\n')
let wireBuffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  wireBuffer += chunk
  for (;;) {
    const nl = wireBuffer.indexOf('\\n')
    if (nl < 0) break
    const line = wireBuffer.slice(0, nl)
    wireBuffer = wireBuffer.slice(nl + 1)
    const message = JSON.parse(line)
    if (message.type === 'exec') {
      process.stdout.write(JSON.stringify({ type: 'done', id: message.id, status: 'ok', executionCount: 1 }) + '\\n')
    }
  }
})
`

function startConfig() {
  return {
    cwd: process.cwd(),
    startupTimeoutMs: 15_000,
    interruptEscalationMs: 5_000,
    shutdownGraceMs: 1_000,
  }
}

describe('KernelHost frame lines (omp 69580d44c0)', () => {
  it('warns on an invalid JSON line with a preview and keeps serving frames', { timeout: 30_000 }, async () => {
    const warns: string[] = []
    const warn = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { warns.push(args.map(String).join(' ')) })
    const kernel = await KernelHost.start({
      ...nodejsKernelProfile(process.execPath),
      stagedSource: INVALID_FRAME_RUNNER,
    }, startConfig())
    try {
      const result = await kernel.execute('after-garbage', '1 + 1', [])
      expect(result.status).toBe('ok')
    } finally {
      await kernel.shutdown()
      warn.mockRestore()
    }
    expect(warns.join('\n')).toContain('emitted invalid JSON')
    expect(warns.join('\n')).toContain('not-json-frame-with-')
  })
})
