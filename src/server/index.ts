// Server-side utilities for reactiveSWR

// Capture built-in timer functions at module load time so that test patches to
// globalThis.setInterval cannot cause infinite recursion inside createChannel.
const _setInterval = globalThis.setInterval.bind(globalThis)
const _clearInterval = globalThis.clearInterval.bind(globalThis)

// biome-ignore lint/suspicious/noExplicitAny: schema generics are erased at runtime
type AnySchema = Record<string, any>

interface ChannelOptions {
  heartbeatInterval?: number
}

interface ScopedEmitter {
  emit(type: string, payload: unknown): void
  close(): void
  onchunk: ((chunk: string) => void) | undefined
}

interface Channel {
  connect(
    reqOrRequest: Request | NodeRequest,
    res?: NodeResponse,
  ): Response | undefined
  respond(): ScopedEmitter
  emit(type: string, payload: unknown): void
  close(): void
}

/** Minimal Node.js IncomingMessage shape */
interface NodeRequest {
  on(event: string, cb: () => void): void
}

/** Minimal Node.js ServerResponse shape */
interface NodeResponse {
  writeHead(status: number, headers: Record<string, string>): void
  write(chunk: string): void
  end(): void
  writableEnded: boolean
  on(event: string, cb: () => void): void
}

const SSE_HEADERS: Record<string, string> = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  Connection: 'keep-alive',
}

const CONNECTED_EVENT = ': connected\n\n'
const HEARTBEAT_COMMENT = ': heartbeat\n\n'

function formatEvent(type: string, payload: unknown): string {
  return `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`
}

/** A client connected via the Web standard (ReadableStream) path */
interface WebClient {
  kind: 'web'
  controller: ReadableStreamDefaultController<Uint8Array>
  encoder: TextEncoder
  closed: boolean
}

/** A client connected via the Node.js (ServerResponse) path */
interface NodeClient {
  kind: 'node'
  res: NodeResponse
}

type Client = WebClient | NodeClient

function writeToClient(client: Client, chunk: string): boolean {
  if (client.kind === 'web') {
    if (client.closed) return false
    try {
      client.controller.enqueue(client.encoder.encode(chunk))
      return true
    } catch {
      client.closed = true
      return false
    }
  }
  if (client.res.writableEnded) return false
  try {
    client.res.write(chunk)
    return true
  } catch {
    return false
  }
}

function closeClient(client: Client): void {
  if (client.kind === 'web') {
    if (!client.closed) {
      client.closed = true
      try {
        client.controller.close()
      } catch {
        // already closed
      }
    }
  } else if (!client.res.writableEnded) {
    try {
      client.res.end()
    } catch {
      // already ended
    }
  }
}

/**
 * Create a server-side SSE channel that broadcasts typed events to connected clients.
 *
 * @example
 * ```ts
 * const channel = createChannel(schema, { heartbeatInterval: 30000 })
 *
 * // Web standard (Fetch API / edge runtimes)
 * export function GET(request: Request) {
 *   return channel.connect(request)
 * }
 *
 * // Node.js HTTP
 * http.createServer((req, res) => channel.connect(req, res))
 *
 * // Broadcast to all clients
 * channel.emit('user.updated', { id: 42 })
 * ```
 */
export function createChannel(
  _schema: AnySchema,
  options: ChannelOptions = {},
): Channel {
  const heartbeatMs = options.heartbeatInterval ?? 30000
  const broadcastPool = new Set<Client>()
  let closed = false
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined

  function startHeartbeat(): void {
    if (heartbeatTimer !== undefined) return
    heartbeatTimer = _setInterval(() => {
      for (const client of broadcastPool) {
        const ok = writeToClient(client, HEARTBEAT_COMMENT)
        if (!ok) broadcastPool.delete(client)
      }
    }, heartbeatMs)
  }

  function stopHeartbeat(): void {
    if (heartbeatTimer !== undefined) {
      _clearInterval(heartbeatTimer)
      heartbeatTimer = undefined
    }
  }

  function connectWeb(request: Request): Response {
    if (closed) throw new Error('Channel is closed')

    // Suppress unused param lint — request is part of the public API signature
    void request

    const encoder = new TextEncoder()
    let clientRef: WebClient | undefined

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const client: WebClient = {
          kind: 'web',
          controller,
          encoder,
          closed: false,
        }
        clientRef = client
        broadcastPool.add(client)
        startHeartbeat()

        // Send initial connected event
        try {
          controller.enqueue(encoder.encode(CONNECTED_EVENT))
        } catch {
          // stream already cancelled
        }
      },
      cancel() {
        if (clientRef) {
          clientRef.closed = true
          broadcastPool.delete(clientRef)
        }
      },
    })

    return new Response(stream, { headers: SSE_HEADERS })
  }

  function connectNode(req: NodeRequest, res: NodeResponse): void {
    if (closed) throw new Error('Channel is closed')
    if (res.writableEnded) throw new Error('ServerResponse is already ended')

    res.writeHead(200, SSE_HEADERS)

    const client: NodeClient = { kind: 'node', res }
    broadcastPool.add(client)
    startHeartbeat()

    // Send initial connected event
    res.write(CONNECTED_EVENT)

    // Listen for disconnect on both req and res
    const onClose = () => {
      broadcastPool.delete(client)
    }
    req.on('close', onClose)
    res.on('close', onClose)
  }

  return {
    connect(
      reqOrRequest: Request | NodeRequest,
      res?: NodeResponse,
    ): Response | undefined {
      if (res !== undefined) {
        connectNode(reqOrRequest as NodeRequest, res)
        return
      }
      return connectWeb(reqOrRequest as Request)
    },

    respond() {
      // Scoped emitter — NOT in broadcast pool, NO heartbeats
      let onchunk: ((chunk: string) => void) | undefined

      const scoped = {
        emit(type: string, payload: unknown): void {
          const chunk = formatEvent(type, payload)
          if (onchunk) onchunk(chunk)
        },
        close(): void {
          // nothing to clean up for a one-shot scoped emitter
        },
        get onchunk() {
          return onchunk
        },
        set onchunk(fn: ((chunk: string) => void) | undefined) {
          onchunk = fn
        },
      }

      return scoped
    },

    emit(type: string, payload: unknown): void {
      if (broadcastPool.size === 0) return

      const chunk = formatEvent(type, payload)
      const dead: Client[] = []

      for (const client of broadcastPool) {
        const ok = writeToClient(client, chunk)
        if (!ok) dead.push(client)
      }

      for (const client of dead) {
        broadcastPool.delete(client)
      }
    },

    close(): void {
      closed = true
      stopHeartbeat()

      for (const client of broadcastPool) {
        closeClient(client)
      }

      broadcastPool.clear()
    },
  }
}
