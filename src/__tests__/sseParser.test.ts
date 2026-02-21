import { describe, expect, it, mock } from 'bun:test'
import { createSSEParser } from '../sseParser.ts'

/**
 * Tests for SSE line parser (createSSEParser).
 *
 * This parser converts raw SSE wire format text into structured events.
 * It handles incremental/chunked input from ReadableStream and must
 * buffer partial lines across chunk boundaries.
 *
 * These tests should FAIL until src/sseParser.ts is implemented.
 */

describe('createSSEParser', () => {
  describe('basic API', () => {
    it('should return an object with feed() and reset() methods', () => {
      const parser = createSSEParser({ onEvent: () => {} })

      expect(parser).toBeDefined()
      expect(typeof parser.feed).toBe('function')
      expect(typeof parser.reset).toBe('function')
    })
  })

  describe('data: field parsing', () => {
    it('should parse a simple data field and dispatch event on blank line', () => {
      const onEvent = mock(() => {})
      const parser = createSSEParser({ onEvent })

      parser.feed('data: hello world\n\n')

      expect(onEvent).toHaveBeenCalledTimes(1)
      expect(onEvent.mock.calls[0][0]).toEqual({
        data: 'hello world',
        event: 'message',
        id: '',
      })
    })

    it('should parse data field without space after colon', () => {
      const onEvent = mock(() => {})
      const parser = createSSEParser({ onEvent })

      parser.feed('data:hello\n\n')

      expect(onEvent).toHaveBeenCalledTimes(1)
      expect(onEvent.mock.calls[0][0].data).toBe('hello')
    })

    it('should handle data with colons in the value', () => {
      const onEvent = mock(() => {})
      const parser = createSSEParser({ onEvent })

      parser.feed('data: http://example.com:8080/path\n\n')

      expect(onEvent).toHaveBeenCalledTimes(1)
      expect(onEvent.mock.calls[0][0].data).toBe('http://example.com:8080/path')
    })

    it('should not dispatch event without a blank line terminator', () => {
      const onEvent = mock(() => {})
      const parser = createSSEParser({ onEvent })

      parser.feed('data: hello\n')

      expect(onEvent).not.toHaveBeenCalled()
    })
  })

  describe('multi-line data fields', () => {
    it('should concatenate multiple data lines with newline', () => {
      const onEvent = mock(() => {})
      const parser = createSSEParser({ onEvent })

      parser.feed('data: line1\ndata: line2\ndata: line3\n\n')

      expect(onEvent).toHaveBeenCalledTimes(1)
      expect(onEvent.mock.calls[0][0].data).toBe('line1\nline2\nline3')
    })

    it('should handle multi-line data with empty data lines', () => {
      const onEvent = mock(() => {})
      const parser = createSSEParser({ onEvent })

      parser.feed('data: line1\ndata:\ndata: line3\n\n')

      expect(onEvent).toHaveBeenCalledTimes(1)
      expect(onEvent.mock.calls[0][0].data).toBe('line1\n\nline3')
    })
  })

  describe('empty data field', () => {
    it('should dispatch event with empty string data for data:\\n\\n', () => {
      const onEvent = mock(() => {})
      const parser = createSSEParser({ onEvent })

      parser.feed('data:\n\n')

      expect(onEvent).toHaveBeenCalledTimes(1)
      expect(onEvent.mock.calls[0][0].data).toBe('')
    })

    it('should dispatch event with empty string data for data: \\n\\n (with space)', () => {
      const onEvent = mock(() => {})
      const parser = createSSEParser({ onEvent })

      // Per SSE spec, the single space after colon is stripped
      parser.feed('data: \n\n')

      expect(onEvent).toHaveBeenCalledTimes(1)
      expect(onEvent.mock.calls[0][0].data).toBe('')
    })
  })

  describe('event: field (named events)', () => {
    it('should default event type to "message" when no event field', () => {
      const onEvent = mock(() => {})
      const parser = createSSEParser({ onEvent })

      parser.feed('data: test\n\n')

      expect(onEvent.mock.calls[0][0].event).toBe('message')
    })

    it('should use event field value as event type', () => {
      const onEvent = mock(() => {})
      const parser = createSSEParser({ onEvent })

      parser.feed('event: user.updated\ndata: test\n\n')

      expect(onEvent.mock.calls[0][0].event).toBe('user.updated')
    })

    it('should reset event type to "message" for subsequent events without event field', () => {
      const onEvent = mock(() => {})
      const parser = createSSEParser({ onEvent })

      parser.feed('event: custom\ndata: first\n\ndata: second\n\n')

      expect(onEvent).toHaveBeenCalledTimes(2)
      expect(onEvent.mock.calls[0][0].event).toBe('custom')
      expect(onEvent.mock.calls[1][0].event).toBe('message')
    })
  })

  describe('id: field', () => {
    it('should track the id field', () => {
      const onEvent = mock(() => {})
      const parser = createSSEParser({ onEvent })

      parser.feed('id: 42\ndata: test\n\n')

      expect(onEvent.mock.calls[0][0].id).toBe('42')
    })

    it('should persist id across events until changed', () => {
      const onEvent = mock(() => {})
      const parser = createSSEParser({ onEvent })

      parser.feed('id: 1\ndata: first\n\ndata: second\n\n')

      expect(onEvent).toHaveBeenCalledTimes(2)
      expect(onEvent.mock.calls[0][0].id).toBe('1')
      expect(onEvent.mock.calls[1][0].id).toBe('1')
    })

    it('should update id when a new id field is provided', () => {
      const onEvent = mock(() => {})
      const parser = createSSEParser({ onEvent })

      parser.feed('id: 1\ndata: first\n\nid: 2\ndata: second\n\n')

      expect(onEvent.mock.calls[0][0].id).toBe('1')
      expect(onEvent.mock.calls[1][0].id).toBe('2')
    })

    it('should handle empty id field', () => {
      const onEvent = mock(() => {})
      const parser = createSSEParser({ onEvent })

      parser.feed('id:\ndata: test\n\n')

      expect(onEvent.mock.calls[0][0].id).toBe('')
    })
  })

  describe('retry: field', () => {
    it('should invoke onRetry callback with parsed milliseconds', () => {
      const onEvent = mock(() => {})
      const onRetry = mock(() => {})
      const parser = createSSEParser({ onEvent, onRetry })

      parser.feed('retry: 3000\ndata: test\n\n')

      expect(onRetry).toHaveBeenCalledTimes(1)
      expect(onRetry).toHaveBeenCalledWith(3000)
    })

    it('should ignore non-integer retry values', () => {
      const onEvent = mock(() => {})
      const onRetry = mock(() => {})
      const parser = createSSEParser({ onEvent, onRetry })

      parser.feed('retry: abc\ndata: test\n\n')

      expect(onRetry).not.toHaveBeenCalled()
    })

    it('should handle retry without onRetry callback', () => {
      const onEvent = mock(() => {})
      const parser = createSSEParser({ onEvent })

      // Should not throw when onRetry is not provided
      expect(() => {
        parser.feed('retry: 3000\ndata: test\n\n')
      }).not.toThrow()
    })

    it('should ignore negative retry values', () => {
      const onEvent = mock(() => {})
      const onRetry = mock(() => {})
      const parser = createSSEParser({ onEvent, onRetry })

      parser.feed('retry: -1000\ndata: test\n\n')

      expect(onRetry).not.toHaveBeenCalled()
    })
  })

  describe('comment lines', () => {
    it('should skip lines starting with colon', () => {
      const onEvent = mock(() => {})
      const parser = createSSEParser({ onEvent })

      parser.feed(': this is a comment\ndata: test\n\n')

      expect(onEvent).toHaveBeenCalledTimes(1)
      expect(onEvent.mock.calls[0][0].data).toBe('test')
    })

    it('should skip multiple comment lines', () => {
      const onEvent = mock(() => {})
      const parser = createSSEParser({ onEvent })

      parser.feed(': comment 1\n: comment 2\ndata: test\n\n')

      expect(onEvent).toHaveBeenCalledTimes(1)
      expect(onEvent.mock.calls[0][0].data).toBe('test')
    })

    it('should not dispatch event for comment-only blocks', () => {
      const onEvent = mock(() => {})
      const parser = createSSEParser({ onEvent })

      parser.feed(': just a comment\n\n')

      expect(onEvent).not.toHaveBeenCalled()
    })
  })

  describe('malformed lines', () => {
    it('should skip lines without a colon', () => {
      const onEvent = mock(() => {})
      const parser = createSSEParser({ onEvent })

      parser.feed('malformed line\ndata: test\n\n')

      expect(onEvent).toHaveBeenCalledTimes(1)
      expect(onEvent.mock.calls[0][0].data).toBe('test')
    })

    it('should skip unknown field names', () => {
      const onEvent = mock(() => {})
      const parser = createSSEParser({ onEvent })

      parser.feed('unknown: value\ndata: test\n\n')

      expect(onEvent).toHaveBeenCalledTimes(1)
      expect(onEvent.mock.calls[0][0].data).toBe('test')
    })
  })

  describe('chunked input (partial lines across feed() calls)', () => {
    it('should handle a line split across two feed calls', () => {
      const onEvent = mock(() => {})
      const parser = createSSEParser({ onEvent })

      parser.feed('dat')
      parser.feed('a: hello\n\n')

      expect(onEvent).toHaveBeenCalledTimes(1)
      expect(onEvent.mock.calls[0][0].data).toBe('hello')
    })

    it('should handle event split across multiple feed calls', () => {
      const onEvent = mock(() => {})
      const parser = createSSEParser({ onEvent })

      parser.feed('event: custom\n')
      parser.feed('data: part1\n')
      parser.feed('data: part2\n')
      parser.feed('\n')

      expect(onEvent).toHaveBeenCalledTimes(1)
      expect(onEvent.mock.calls[0][0].event).toBe('custom')
      expect(onEvent.mock.calls[0][0].data).toBe('part1\npart2')
    })

    it('should handle blank line split across feed calls', () => {
      const onEvent = mock(() => {})
      const parser = createSSEParser({ onEvent })

      parser.feed('data: test\n')
      parser.feed('\n')

      expect(onEvent).toHaveBeenCalledTimes(1)
      expect(onEvent.mock.calls[0][0].data).toBe('test')
    })

    it('should handle data value split in the middle', () => {
      const onEvent = mock(() => {})
      const parser = createSSEParser({ onEvent })

      parser.feed('data: hel')
      parser.feed('lo world\n\n')

      expect(onEvent).toHaveBeenCalledTimes(1)
      expect(onEvent.mock.calls[0][0].data).toBe('hello world')
    })

    it('should handle multiple events across chunks', () => {
      const onEvent = mock(() => {})
      const parser = createSSEParser({ onEvent })

      parser.feed('data: first\n\ndata: sec')
      parser.feed('ond\n\n')

      expect(onEvent).toHaveBeenCalledTimes(2)
      expect(onEvent.mock.calls[0][0].data).toBe('first')
      expect(onEvent.mock.calls[1][0].data).toBe('second')
    })
  })

  describe('BOM handling', () => {
    it('should strip BOM at the start of stream', () => {
      const onEvent = mock(() => {})
      const parser = createSSEParser({ onEvent })

      parser.feed('\uFEFFdata: test\n\n')

      expect(onEvent).toHaveBeenCalledTimes(1)
      expect(onEvent.mock.calls[0][0].data).toBe('test')
    })

    it('should only strip BOM at the very start, not in subsequent chunks', () => {
      const onEvent = mock(() => {})
      const parser = createSSEParser({ onEvent })

      parser.feed('data: first\n\n')
      parser.feed('\uFEFFdata: second\n\n')

      expect(onEvent).toHaveBeenCalledTimes(2)
      // BOM in subsequent data should not be stripped from the wire format
      // (but it won't affect field parsing since it's not at stream start)
    })
  })

  describe('line terminators', () => {
    it('should handle \\n line endings', () => {
      const onEvent = mock(() => {})
      const parser = createSSEParser({ onEvent })

      parser.feed('data: test\n\n')

      expect(onEvent).toHaveBeenCalledTimes(1)
      expect(onEvent.mock.calls[0][0].data).toBe('test')
    })

    it('should handle \\r\\n line endings', () => {
      const onEvent = mock(() => {})
      const parser = createSSEParser({ onEvent })

      parser.feed('data: test\r\n\r\n')

      expect(onEvent).toHaveBeenCalledTimes(1)
      expect(onEvent.mock.calls[0][0].data).toBe('test')
    })

    it('should handle \\r line endings', () => {
      const onEvent = mock(() => {})
      const parser = createSSEParser({ onEvent })

      parser.feed('data: test\r\r')

      expect(onEvent).toHaveBeenCalledTimes(1)
      expect(onEvent.mock.calls[0][0].data).toBe('test')
    })

    it('should handle mixed line endings', () => {
      const onEvent = mock(() => {})
      const parser = createSSEParser({ onEvent })

      parser.feed('data: line1\r\ndata: line2\rdata: line3\n\n')

      expect(onEvent).toHaveBeenCalledTimes(1)
      expect(onEvent.mock.calls[0][0].data).toBe('line1\nline2\nline3')
    })
  })

  describe('reset()', () => {
    it('should clear buffered state', () => {
      const onEvent = mock(() => {})
      const parser = createSSEParser({ onEvent })

      // Feed partial data
      parser.feed('data: partial')
      parser.reset()

      // Feed new complete event
      parser.feed('data: fresh\n\n')

      expect(onEvent).toHaveBeenCalledTimes(1)
      expect(onEvent.mock.calls[0][0].data).toBe('fresh')
    })

    it('should clear id state', () => {
      const onEvent = mock(() => {})
      const parser = createSSEParser({ onEvent })

      parser.feed('id: 42\ndata: first\n\n')
      parser.reset()
      parser.feed('data: second\n\n')

      expect(onEvent).toHaveBeenCalledTimes(2)
      expect(onEvent.mock.calls[0][0].id).toBe('42')
      expect(onEvent.mock.calls[1][0].id).toBe('')
    })

    it('should clear event type state', () => {
      const onEvent = mock(() => {})
      const parser = createSSEParser({ onEvent })

      parser.feed('event: custom\n')
      parser.reset()
      parser.feed('data: test\n\n')

      expect(onEvent).toHaveBeenCalledTimes(1)
      expect(onEvent.mock.calls[0][0].event).toBe('message')
    })

    it('should allow BOM stripping again after reset', () => {
      const onEvent = mock(() => {})
      const parser = createSSEParser({ onEvent })

      parser.feed('\uFEFFdata: first\n\n')
      parser.reset()
      parser.feed('\uFEFFdata: second\n\n')

      expect(onEvent).toHaveBeenCalledTimes(2)
      expect(onEvent.mock.calls[0][0].data).toBe('first')
      expect(onEvent.mock.calls[1][0].data).toBe('second')
    })
  })

  describe('event dispatch rules', () => {
    it('should not dispatch event if no data field was set', () => {
      const onEvent = mock(() => {})
      const parser = createSSEParser({ onEvent })

      // Only event field, no data field
      parser.feed('event: custom\n\n')

      expect(onEvent).not.toHaveBeenCalled()
    })

    it('should dispatch multiple events separated by blank lines', () => {
      const onEvent = mock(() => {})
      const parser = createSSEParser({ onEvent })

      parser.feed('data: first\n\ndata: second\n\ndata: third\n\n')

      expect(onEvent).toHaveBeenCalledTimes(3)
      expect(onEvent.mock.calls[0][0].data).toBe('first')
      expect(onEvent.mock.calls[1][0].data).toBe('second')
      expect(onEvent.mock.calls[2][0].data).toBe('third')
    })

    it('should handle all fields together', () => {
      const onEvent = mock(() => {})
      const onRetry = mock(() => {})
      const parser = createSSEParser({ onEvent, onRetry })

      parser.feed('id: 99\nevent: update\nretry: 5000\ndata: payload\n\n')

      expect(onEvent).toHaveBeenCalledTimes(1)
      expect(onEvent.mock.calls[0][0]).toEqual({
        data: 'payload',
        event: 'update',
        id: '99',
      })
      expect(onRetry).toHaveBeenCalledWith(5000)
    })
  })

  describe('edge cases (probing)', () => {
    it('should handle \\r\\n split across two chunks', () => {
      const onEvent = mock(() => {})
      const parser = createSSEParser({ onEvent })

      // Chunk 1 ends with \r, chunk 2 starts with \n
      // This is a single \r\n line ending split across chunks
      parser.feed('data: hello\r')
      parser.feed('\ndata: world\n\n')

      // Should produce exactly one event with two data lines
      expect(onEvent).toHaveBeenCalledTimes(1)
      expect(onEvent.mock.calls[0][0].data).toBe('hello\nworld')
    })

    it('should handle \\r at end of chunk followed by \\n at start of next (with dispatch)', () => {
      const onEvent = mock(() => {})
      const parser = createSSEParser({ onEvent })

      // data: test\r is chunk boundary, then \n\n triggers dispatch
      parser.feed('data: test\r')
      parser.feed('\n\n')

      expect(onEvent).toHaveBeenCalledTimes(1)
      expect(onEvent.mock.calls[0][0].data).toBe('test')
    })

    it('should handle empty feed calls', () => {
      const onEvent = mock(() => {})
      const parser = createSSEParser({ onEvent })

      parser.feed('')
      parser.feed('')
      parser.feed('data: test\n\n')
      parser.feed('')

      expect(onEvent).toHaveBeenCalledTimes(1)
      expect(onEvent.mock.calls[0][0].data).toBe('test')
    })

    it('should handle unicode/emoji in data', () => {
      const onEvent = mock(() => {})
      const parser = createSSEParser({ onEvent })

      parser.feed('data: Hello \u{1F600}\u{1F389} World\n\n')

      expect(onEvent).toHaveBeenCalledTimes(1)
      expect(onEvent.mock.calls[0][0].data).toBe(
        'Hello \u{1F600}\u{1F389} World',
      )
    })

    it('should handle unicode split across chunks', () => {
      const onEvent = mock(() => {})
      const parser = createSSEParser({ onEvent })

      // Note: JavaScript strings are UTF-16, so multi-byte chars won't
      // actually split at byte boundary here. But we can split the text.
      parser.feed('data: Hello \u{1F600}')
      parser.feed(' World\n\n')

      expect(onEvent).toHaveBeenCalledTimes(1)
      expect(onEvent.mock.calls[0][0].data).toBe('Hello \u{1F600} World')
    })

    it('should handle very large data payloads', () => {
      const onEvent = mock(() => {})
      const parser = createSSEParser({ onEvent })

      const largePayload = 'x'.repeat(1_000_000)
      parser.feed(`data: ${largePayload}\n\n`)

      expect(onEvent).toHaveBeenCalledTimes(1)
      expect(onEvent.mock.calls[0][0].data).toBe(largePayload)
    })

    it('should handle rapid sequential events', () => {
      const onEvent = mock(() => {})
      const parser = createSSEParser({ onEvent })

      for (let i = 0; i < 100; i++) {
        parser.feed(`data: event-${i}\n\n`)
      }

      expect(onEvent).toHaveBeenCalledTimes(100)
      expect(onEvent.mock.calls[0][0].data).toBe('event-0')
      expect(onEvent.mock.calls[99][0].data).toBe('event-99')
    })

    it('should handle feed() after reset() correctly', () => {
      const onEvent = mock(() => {})
      const parser = createSSEParser({ onEvent })

      parser.feed('id: 10\nevent: custom\ndata: first')
      parser.reset()

      // After reset, should behave like a fresh parser
      parser.feed('data: fresh start\n\n')

      expect(onEvent).toHaveBeenCalledTimes(1)
      expect(onEvent.mock.calls[0][0].data).toBe('fresh start')
      expect(onEvent.mock.calls[0][0].event).toBe('message')
      expect(onEvent.mock.calls[0][0].id).toBe('')
    })

    it('should handle multiple blank lines between events', () => {
      const onEvent = mock(() => {})
      const parser = createSSEParser({ onEvent })

      parser.feed('data: first\n\n\n\ndata: second\n\n')

      // Extra blank lines should NOT produce extra events (no data pending)
      expect(onEvent).toHaveBeenCalledTimes(2)
      expect(onEvent.mock.calls[0][0].data).toBe('first')
      expect(onEvent.mock.calls[1][0].data).toBe('second')
    })

    it('should handle data field with only spaces (not stripped)', () => {
      const onEvent = mock(() => {})
      const parser = createSSEParser({ onEvent })

      // "data:   " -> strip leading space -> "  " (two spaces)
      parser.feed('data:   \n\n')

      expect(onEvent).toHaveBeenCalledTimes(1)
      expect(onEvent.mock.calls[0][0].data).toBe('  ')
    })

    it('should handle retry with float value (not integer)', () => {
      const onEvent = mock(() => {})
      const onRetry = mock(() => {})
      const parser = createSSEParser({ onEvent, onRetry })

      parser.feed('retry: 3.5\ndata: test\n\n')

      // 3.5 is not an integer, so onRetry should NOT be called
      expect(onRetry).not.toHaveBeenCalled()
    })

    it('should handle retry: 0 as valid', () => {
      const onEvent = mock(() => {})
      const onRetry = mock(() => {})
      const parser = createSSEParser({ onEvent, onRetry })

      parser.feed('retry: 0\ndata: test\n\n')

      expect(onRetry).toHaveBeenCalledTimes(1)
      expect(onRetry).toHaveBeenCalledWith(0)
    })

    it('should handle BOM in processLine (mid-stream BOM at line start)', () => {
      const onEvent = mock(() => {})
      const parser = createSSEParser({ onEvent })

      // First chunk consumed the BOM check in feed(), but a BOM
      // at the start of a line should be stripped by processLine
      parser.feed('data: first\n\n')
      parser.feed('\uFEFFdata: second\n\n')

      expect(onEvent).toHaveBeenCalledTimes(2)
      expect(onEvent.mock.calls[0][0].data).toBe('first')
      // The BOM in the second chunk is NOT stripped by feed() (not firstChunk).
      // processLine sees "\uFEFFdata: second" -- the BOM is at charCodeAt(0),
      // so it strips it, leaving "data: second" which parses correctly.
      expect(onEvent.mock.calls[1][0].data).toBe('second')
    })

    it('should handle standalone \\r at chunk end (not followed by \\n in next chunk)', () => {
      const onEvent = mock(() => {})
      const parser = createSSEParser({ onEvent })

      // \r alone is a valid line terminator; next chunk starts a new line
      parser.feed('data: hello\r')
      parser.feed('data: world\n\n')

      expect(onEvent).toHaveBeenCalledTimes(1)
      expect(onEvent.mock.calls[0][0].data).toBe('hello\nworld')
    })

    it('should handle \\r\\r split across chunks (two \\r line endings)', () => {
      const onEvent = mock(() => {})
      const parser = createSSEParser({ onEvent })

      // First \r ends the data line, second \r is the empty line that dispatches
      parser.feed('data: test\r')
      parser.feed('\r')

      expect(onEvent).toHaveBeenCalledTimes(1)
      expect(onEvent.mock.calls[0][0].data).toBe('test')
    })
  })
})
