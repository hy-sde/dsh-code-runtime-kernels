/**
 * Byte-level LF splitter for kernel frame streams — the perf port of omp
 * 69580d44c0 (#14704). The old readers accumulated decoded strings and
 * tail-joined the buffer on every chunk, re-copying the whole buffered prefix
 * per chunk; this splitter scans each chunk for 0x0A and appends only the
 * trailing suffix, so appending N chunks costs O(total bytes) instead of
 * O(chunks × buffered bytes). Lines are decoded only once complete — a UTF-8
 * sequence never contains a line break, so per-line decode is multibyte-safe
 * across chunk boundaries — and each line is its own string, aliasing neither
 * the input chunk nor the internal buffer.
 * @module @hy-sde-org/dsh-code-runtime-kernels/src/core/lines
 */

import { Buffer } from 'node:buffer'

/** Capacity above this is released once drained, so one oversized frame does not pin its peak buffer for the stream's life. */
const RETAIN_BYTES = 1024 * 1024

const LF = 0x0a

/**
 * Splits a kernel frame stream into decoded lines, pushed chunk by chunk.
 * Blank lines are yielded; callers skip them before JSON parsing.
 */
export class LineSplitter {
  #buffer = Buffer.allocUnsafe(0)
  #length = 0
  #decoder = new TextDecoder()

  /**
   * Split one chunk, returning every complete line it ends, decoded UTF-8 and
   * excluding the terminators. A chunk boundary inside a line keeps the
   * partial bytes buffered until their terminator arrives.
   * @param chunk - Next bytes from the frame stream.
   * @returns The chunk's complete lines, in order.
   */
  push(chunk: Uint8Array): string[] {
    const lines: string[] = []
    let position = 0
    while (position < chunk.length) {
      const nl = chunk.indexOf(LF, position)
      if (nl === -1) {
        this.#append(chunk.subarray(position))
        return lines
      }
      const suffix = chunk.subarray(position, nl)
      position = nl + 1
      if (this.#length === 0) {
        lines.push(this.#decoder.decode(suffix))
      } else {
        this.#append(suffix)
        lines.push(this.#drain())
      }
    }
    return lines
  }

  /**
   * The trailing unterminated line at end of stream, or `undefined`; the
   * buffer is empty afterwards either way.
   * @returns The final partial line, when one was buffered.
   */
  flush(): string | undefined {
    if (this.#length === 0) return undefined
    return this.#drain()
  }

  #append(bytes: Uint8Array): void {
    const size = bytes.length
    if (size === 0) return
    if (this.#length + size > this.#buffer.length) {
      const next = Buffer.allocUnsafe(Math.max(this.#length + size, this.#buffer.length * 2))
      this.#buffer.copy(next, 0, 0, this.#length)
      this.#buffer = next
    }
    this.#buffer.set(bytes, this.#length)
    this.#length += size
  }

  #drain(): string {
    const line = this.#decoder.decode(this.#buffer.subarray(0, this.#length))
    const drained = this.#length
    this.#length = 0
    this.#releaseCapacity(drained)
    return line
  }

  #releaseCapacity(drained: number): void {
    if (this.#buffer.length <= RETAIN_BYTES) return
    // The just-drained line still filled ≥25% of the buffer: a stream of
    // oversized frames would re-grow per line.
    if (drained * 4 > this.#buffer.length) return
    this.#buffer = Buffer.allocUnsafe(0)
  }
}
