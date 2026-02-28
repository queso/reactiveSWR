import type { SSEAdapter } from './types.ts'

type EventListener = (...args: unknown[]) => void | Promise<void>

interface OnOffEmitter {
  on(event: string, listener: EventListener): void
  off(event: string, listener: EventListener): void
}

type EmitterAdapterMapping = {
  [emitterEvent: string]: string
}

/**
 * Create an adapter that bridges any on/off-compatible event emitter to SSE events.
 *
 * Does NOT require Node.js EventEmitter — works with any object that has
 * on(event, listener) and off(event, listener) methods.
 */
export function createEmitterAdapter(
  emitter: OnOffEmitter,
  mapping: EmitterAdapterMapping,
): SSEAdapter {
  const handlers = new Map<string, EventListener>()
  let started = false

  return {
    start(emit: (eventType: string, payload: unknown) => void): void {
      if (started) return

      for (const [emitterEvent, schemaEvent] of Object.entries(mapping)) {
        const handler: EventListener = (...args: unknown[]) => {
          try {
            emit(schemaEvent, args[0])
          } catch {
            // emit() errors must not propagate through the emitter's event dispatch
          }
        }
        handlers.set(emitterEvent, handler)
        emitter.on(emitterEvent, handler)
      }
      started = true
    },

    stop(): void {
      for (const [emitterEvent, handler] of handlers) {
        try {
          emitter.off(emitterEvent, handler)
        } catch {
          // best-effort cleanup
        }
      }
      handlers.clear()
      started = false
    },
  }
}
