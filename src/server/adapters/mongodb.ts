import type { SSEAdapter } from './types.ts'

interface ChangeEvent {
  _id: unknown
  operationType: string
  fullDocument?: Record<string, unknown>
  documentKey?: { _id: unknown }
  updateDescription?: { updatedFields: Record<string, unknown> }
  ns?: { db: string; coll: string }
}

interface ChangeStreamCursor {
  [Symbol.asyncIterator](): AsyncIterator<ChangeEvent | undefined>
  close(): Promise<void>
}

interface MongoCollection {
  // biome-ignore lint/suspicious/noExplicitAny: watch options are driver-specific
  watch(options?: Record<string, any>): ChangeStreamCursor
}

type MongoAdapterMapping = {
  [operationType: string]: string
}

/**
 * Create a MongoDB Change Stream adapter that watches a collection and emits
 * SSE events for insert/update/replace/delete operations.
 *
 * Does NOT import mongodb — accepts the collection instance as a parameter.
 * Handles invalidate events by reopening the stream with a resume token.
 */
export function createMongoAdapter(
  collection: MongoCollection,
  mapping: MongoAdapterMapping,
): SSEAdapter {
  let stopped = false
  let started = false
  let currentCursor: ChangeStreamCursor | undefined
  let resumeToken: unknown

  const MAX_RECONNECT_ATTEMPTS = 5
  let reconnectAttempts = 0

  async function runStream(
    emit: (eventType: string, payload: unknown) => void,
  ): Promise<void> {
    // biome-ignore lint/suspicious/noExplicitAny: resume token shape is driver-specific
    const options: Record<string, any> = {}
    if (resumeToken !== undefined) {
      options.resumeAfter = resumeToken
    }

    const cursor = collection.watch(options)
    currentCursor = cursor

    try {
      for await (const event of cursor) {
        if (stopped) break
        if (!event) continue

        // Handle invalidate — close current cursor and reopen
        // (do NOT update resume token for invalidate events)
        if (event.operationType === 'invalidate') {
          try {
            await cursor.close()
          } catch {
            /* ignore */
          }
          currentCursor = undefined
          if (!stopped && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
            reconnectAttempts++
            // Reopen with the last resume token
            await runStream(emit)
          }
          return
        }

        // Track resume token from regular (non-invalidate) events
        if (event._id !== undefined) {
          resumeToken = event._id
        }

        // Emit mapped events
        const eventType = mapping[event.operationType]
        if (eventType) {
          // Payload: fullDocument for insert/update/replace, documentKey for delete
          const payload = event.fullDocument ?? event.documentKey ?? event
          try {
            emit(eventType, payload)
          } catch {
            // emit() errors must not break the stream iteration
          }
        }
      }
    } catch {
      // Stream closed or errored — stop iteration
    }
  }

  return {
    async start(
      emit: (eventType: string, payload: unknown) => void,
    ): Promise<void> {
      if (started) return

      stopped = false
      started = true
      reconnectAttempts = 0
      await runStream(emit)
    },

    async stop(): Promise<void> {
      stopped = true
      started = false
      if (currentCursor) {
        try {
          await currentCursor.close()
        } catch {
          /* ignore */
        }
        currentCursor = undefined
      }
    },
  }
}
