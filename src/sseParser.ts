export interface SSEEvent {
  data: string
  event: string
  id: string
  retry?: number
}

export interface SSEParserCallbacks {
  onEvent: (event: SSEEvent) => void
  onRetry?: (ms: number) => void
}

export interface SSEParser {
  feed(chunk: string): void
  reset(): void
}

/** Format a named SSE event with event type and JSON payload. */
export function formatSSEEvent(type: string, payload: unknown): string {
  return `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`
}

/** Format an unnamed SSE data-only message. */
export function formatSSEData(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`
}

export function createSSEParser(callbacks: SSEParserCallbacks): SSEParser {
  let buffer = ''
  let dataLines: string[] = []
  let eventType = ''
  let lastEventId = ''
  let hasData = false
  let firstChunk = true
  let trailingCR = false

  function processLine(line: string): void {
    // Strip BOM if present at start of line
    if (line.charCodeAt(0) === 0xfeff) {
      line = line.slice(1)
    }

    // Empty line = dispatch event
    if (line === '') {
      if (hasData) {
        callbacks.onEvent({
          data: dataLines.join('\n'),
          event: eventType || 'message',
          id: lastEventId,
        })
      }
      // Reset per-event fields
      dataLines = []
      eventType = ''
      hasData = false
      return
    }

    // Comment line
    if (line.startsWith(':')) {
      return
    }

    // Find first colon
    const colonIdx = line.indexOf(':')
    if (colonIdx === -1) {
      // No colon - skip line per spec
      return
    }

    const field = line.slice(0, colonIdx)
    let value = line.slice(colonIdx + 1)

    // Strip single leading space from value if present
    if (value.startsWith(' ')) {
      value = value.slice(1)
    }

    switch (field) {
      case 'data':
        hasData = true
        dataLines.push(value)
        break
      case 'event':
        eventType = value
        break
      case 'id':
        lastEventId = value
        break
      case 'retry': {
        const ms = Number(value)
        if (Number.isInteger(ms) && ms >= 0) {
          callbacks.onRetry?.(ms)
        }
        break
      }
      // Unknown fields are ignored per spec
    }
  }

  function feed(chunk: string): void {
    // Strip BOM at start of stream
    if (firstChunk) {
      if (chunk.startsWith('\uFEFF')) {
        chunk = chunk.slice(1)
      }
      firstChunk = false
    }

    buffer += chunk

    // If previous chunk ended with \r and this chunk starts with \n,
    // consume the \n as part of the \r\n pair (line was already processed)
    let start = 0
    if (trailingCR && buffer.length > 0 && buffer[0] === '\n') {
      start = 1
    }
    trailingCR = false

    // Process complete lines from buffer
    // We need to handle \r\n, \r, and \n line endings
    for (let i = start; i < buffer.length; i++) {
      const ch = buffer[i]
      if (ch === '\r' || ch === '\n') {
        // If \r is the last character in the buffer, we can't tell if it's
        // a standalone \r or part of a \r\n pair. Keep it in the buffer and
        // set the trailingCR flag so the next feed() can resolve it.
        if (ch === '\r' && i + 1 === buffer.length) {
          trailingCR = true
          const line = buffer.slice(start, i)
          processLine(line)
          start = i + 1
          break
        }
        const line = buffer.slice(start, i)
        // If \r is followed by \n, skip the \n
        if (ch === '\r' && i + 1 < buffer.length && buffer[i + 1] === '\n') {
          i++
        }
        processLine(line)
        start = i + 1
      }
    }

    // Keep remaining partial line in buffer
    buffer = buffer.slice(start)
  }

  function reset(): void {
    buffer = ''
    dataLines = []
    eventType = ''
    lastEventId = ''
    hasData = false
    firstChunk = true
    trailingCR = false
  }

  return { feed, reset }
}
