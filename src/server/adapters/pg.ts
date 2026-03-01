import type { SSEAdapter } from './types.ts'

interface PgNotification {
  channel: string
  payload?: string
  processId?: number
}

interface PgClient {
  query(sql: string): Promise<unknown>
  on(event: string, listener: (notification: PgNotification) => void): void
  off?(event: string, listener: (notification: PgNotification) => void): void
  removeListener?(
    event: string,
    listener: (notification: PgNotification) => void,
  ): void
}

type PgAdapterMapping = {
  [channelName: string]: string
}

/**
 * Create a PostgreSQL LISTEN/NOTIFY adapter that listens on pg channels and
 * emits SSE events when NOTIFY messages arrive.
 *
 * Does NOT import pg — accepts the client instance as a parameter.
 * Calls UNLISTEN and removes event listeners on stop().
 */
export function createPgAdapter(
  client: PgClient,
  mapping: PgAdapterMapping,
): SSEAdapter {
  let notificationListener: ((notification: PgNotification) => void) | undefined
  let started = false
  const channels = Object.keys(mapping)

  /**
   * Quote a PostgreSQL identifier to prevent SQL injection and reserved keyword
   * collisions. Always uses double-quote escaping per PostgreSQL rules — this is
   * safe for all identifiers and avoids issues with reserved keywords like
   * "select", "table", "index" that would be syntactically invalid unquoted.
   */
  function quoteIdentifier(name: string): string {
    return `"${name.replace(/"/g, '""')}"`
  }

  function removeListener(): void {
    if (!notificationListener) return
    const fn = notificationListener
    notificationListener = undefined
    if (typeof client.off === 'function') {
      client.off('notification', fn)
    } else if (typeof client.removeListener === 'function') {
      client.removeListener('notification', fn)
    } else {
      console.warn(
        'PostgreSQL client does not support off() or removeListener() — notification handler may leak',
      )
    }
  }

  return {
    async start(
      emit: (eventType: string, payload: unknown) => void,
    ): Promise<void> {
      if (started) return

      // Issue LISTEN for each mapped channel with proper identifier quoting
      await Promise.all(
        channels.map((ch) => client.query(`LISTEN ${quoteIdentifier(ch)}`)),
      )

      // Only mark started after LISTEN queries succeed
      started = true

      // Register a single notification listener
      notificationListener = (notification: PgNotification) => {
        const eventType = mapping[notification.channel]
        if (!eventType) return

        // Parse JSON payload; fall back gracefully for empty/malformed payloads
        let parsed: unknown
        if (notification.payload) {
          try {
            parsed = JSON.parse(notification.payload)
          } catch {
            // Malformed JSON — emit undefined payload rather than throwing
          }
        }

        try {
          emit(eventType, parsed)
        } catch {
          // emit() errors must not propagate as uncaught exceptions
        }
      }

      client.on('notification', notificationListener)
    },

    async stop(): Promise<void> {
      removeListener()
      started = false
      // Issue UNLISTEN for each channel with proper identifier quoting
      await Promise.all(
        channels.map((ch) => client.query(`UNLISTEN ${quoteIdentifier(ch)}`)),
      )
    },
  }
}
