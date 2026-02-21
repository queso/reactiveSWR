import { describe, expect, it } from 'bun:test'
import type {
  EventMapping,
  ParsedEvent,
  ReconnectConfig,
  SSEConfig,
  SSEProviderProps,
  SSERequestOptions,
  SSEStatus,
  SSETransport,
  UpdateStrategy,
} from '../types.ts'

/**
 * Type-level tests for transport abstraction types.
 *
 * These tests verify that:
 * 1. SSETransport interface exists with all required members
 * 2. SSERequestOptions interface exists with correct shape
 * 3. SSEConfig is extended with optional method, body, headers, and transport
 * 4. All new types are exported from src/index.ts
 * 5. Existing types are not broken by the additions
 */

describe('Transport abstraction types', () => {
  describe('SSETransport interface', () => {
    it('should have onmessage, onerror, and onopen callback properties', () => {
      const transport: SSETransport = {
        onmessage: (_event: MessageEvent) => {},
        onerror: (_event: Event) => {},
        onopen: (_event: Event) => {},
        readyState: 0,
        close: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
      }

      // Verify callback properties exist and accept correct types
      const onmessage: ((event: MessageEvent) => void) | null =
        transport.onmessage
      const onerror: ((event: Event) => void) | null = transport.onerror
      const onopen: ((event: Event) => void) | null = transport.onopen

      expect(onmessage).toBeDefined()
      expect(onerror).toBeDefined()
      expect(onopen).toBeDefined()
    })

    it('should have a close() method returning void', () => {
      const transport: SSETransport = {
        onmessage: null,
        onerror: null,
        onopen: null,
        readyState: 0,
        close: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
      }

      const closeFn: () => void = transport.close
      expect(closeFn).toBeDefined()
    })

    it('should have a readyState property of type number', () => {
      const transport: SSETransport = {
        onmessage: null,
        onerror: null,
        onopen: null,
        readyState: 0,
        close: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
      }

      const readyState: number = transport.readyState
      expect(typeof readyState).toBe('number')
    })

    it('should have addEventListener for named SSE data events', () => {
      const transport: SSETransport = {
        onmessage: null,
        onerror: null,
        onopen: null,
        readyState: 0,
        close: () => {},
        addEventListener: (
          _type: string,
          _listener: (event: MessageEvent) => void,
        ) => {},
        removeEventListener: () => {},
      }

      const addListener: (
        type: string,
        listener: (event: MessageEvent) => void,
      ) => void = transport.addEventListener
      expect(addListener).toBeDefined()
    })

    it('should have removeEventListener for named SSE data events', () => {
      const transport: SSETransport = {
        onmessage: null,
        onerror: null,
        onopen: null,
        readyState: 0,
        close: () => {},
        addEventListener: () => {},
        removeEventListener: (
          _type: string,
          _listener: (event: MessageEvent) => void,
        ) => {},
      }

      const removeListener: (
        type: string,
        listener: (event: MessageEvent) => void,
      ) => void = transport.removeEventListener
      expect(removeListener).toBeDefined()
    })

    it('should be assignable from a conforming object literal', () => {
      // Verify a full implementation satisfies the interface
      const transport: SSETransport = {
        onmessage: null,
        onerror: null,
        onopen: null,
        readyState: 0,
        close: () => {},
        addEventListener: (
          _type: string,
          _listener: (event: MessageEvent) => void,
        ) => {},
        removeEventListener: (
          _type: string,
          _listener: (event: MessageEvent) => void,
        ) => {},
      }

      expect(transport.readyState).toBe(0)
      expect(transport.onmessage).toBeNull()
      expect(transport.onerror).toBeNull()
      expect(transport.onopen).toBeNull()
    })

    it('should allow setting callback properties to functions', () => {
      const transport: SSETransport = {
        onmessage: (_event: MessageEvent) => {},
        onerror: (_event: Event) => {},
        onopen: (_event: Event) => {},
        readyState: 1,
        close: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
      }

      expect(typeof transport.onmessage).toBe('function')
      expect(typeof transport.onerror).toBe('function')
      expect(typeof transport.onopen).toBe('function')
    })
  })

  describe('SSERequestOptions interface', () => {
    it('should accept an empty object (all fields optional)', () => {
      const options: SSERequestOptions = {}
      expect(options).toBeDefined()
    })

    it('should accept optional method field as string', () => {
      const options: SSERequestOptions = {
        method: 'POST',
      }
      expect(options.method).toBe('POST')
    })

    it('should accept optional body field as BodyInit', () => {
      const options: SSERequestOptions = {
        body: JSON.stringify({ query: 'test' }),
      }
      expect(options.body).toBeDefined()
    })

    it('should accept optional body field as Record<string, unknown>', () => {
      const options: SSERequestOptions = {
        body: { query: 'test', limit: 10 },
      }
      expect(options.body).toBeDefined()
    })

    it('should accept optional headers field', () => {
      const options: SSERequestOptions = {
        headers: {
          Authorization: 'Bearer token',
          'Content-Type': 'application/json',
        },
      }
      expect(options.headers?.Authorization).toBe('Bearer token')
    })

    it('should accept all fields together', () => {
      const options: SSERequestOptions = {
        method: 'POST',
        body: JSON.stringify({ query: 'test' }),
        headers: { 'Content-Type': 'application/json' },
      }
      expect(options.method).toBe('POST')
      expect(options.body).toBeDefined()
      expect(options.headers).toBeDefined()
    })
  })

  describe('SSEConfig transport extensions', () => {
    it('should accept optional method field', () => {
      const config: SSEConfig = {
        url: 'http://localhost:3000/events',
        events: {},
        method: 'POST',
      }
      expect(config.method).toBe('POST')
    })

    it('should accept optional body field as string', () => {
      const config: SSEConfig = {
        url: 'http://localhost:3000/events',
        events: {},
        body: JSON.stringify({ query: 'test' }),
      }
      expect(config.body).toBeDefined()
    })

    it('should accept optional body field as Record<string, unknown>', () => {
      const config: SSEConfig = {
        url: 'http://localhost:3000/events',
        events: {},
        body: { query: 'test', limit: 10 },
      }
      expect(config.body).toBeDefined()
    })

    it('should accept optional headers field', () => {
      const config: SSEConfig = {
        url: 'http://localhost:3000/events',
        events: {},
        headers: {
          Authorization: 'Bearer token',
        },
      }
      expect(config.headers?.Authorization).toBe('Bearer token')
    })

    it('should accept optional transport factory function', () => {
      const mockTransport: SSETransport = {
        onmessage: null,
        onerror: null,
        onopen: null,
        readyState: 0,
        close: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
      }

      const config: SSEConfig = {
        url: 'http://localhost:3000/events',
        events: {},
        transport: (_url: string) => mockTransport,
      }
      expect(config.transport).toBeDefined()
      expect(typeof config.transport).toBe('function')
    })

    it('should still work without any transport fields (backward compatible)', () => {
      const config: SSEConfig = {
        url: 'http://localhost:3000/events',
        events: {
          'user.updated': {
            key: '/api/user',
            update: 'set',
          },
        },
        parseEvent: (event: MessageEvent) => ({
          type: 'test',
          payload: event.data,
        }),
        onConnect: () => {},
        onError: (_error: Event) => {},
        onDisconnect: () => {},
        reconnect: { enabled: true },
        debug: true,
      }
      expect(config.url).toBe('http://localhost:3000/events')
      // Verify transport fields are undefined when not set
      expect(config.method).toBeUndefined()
      expect(config.body).toBeUndefined()
      expect(config.headers).toBeUndefined()
      expect(config.transport).toBeUndefined()
    })

    it('should accept all transport fields together with existing fields', () => {
      const mockTransport: SSETransport = {
        onmessage: null,
        onerror: null,
        onopen: null,
        readyState: 0,
        close: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
      }

      const config: SSEConfig = {
        url: 'http://localhost:3000/events',
        events: {},
        method: 'POST',
        body: JSON.stringify({ subscribe: ['user.updated'] }),
        headers: { 'Content-Type': 'application/json' },
        transport: (_url: string) => mockTransport,
        onConnect: () => {},
        reconnect: { enabled: true },
        debug: true,
      }
      expect(config.method).toBe('POST')
      expect(config.transport).toBeDefined()
    })
  })

  describe('Exports from index.ts', () => {
    it('should export SSETransport type', async () => {
      // Verify SSETransport is exported from the main entry point
      const transport: import('../index.ts').SSETransport = {
        onmessage: null,
        onerror: null,
        onopen: null,
        readyState: 0,
        close: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
      }
      expect(transport.readyState).toBe(0)
    })

    it('should export SSERequestOptions type', async () => {
      // Verify SSERequestOptions is exported from the main entry point
      const options: import('../index.ts').SSERequestOptions = {
        method: 'POST',
        body: '{}',
        headers: { 'Content-Type': 'application/json' },
      }
      expect(options.method).toBe('POST')
    })
  })

  describe('Existing types are not broken', () => {
    it('should still export and validate all original types', () => {
      // ParsedEvent
      const event: ParsedEvent = { type: 'test', payload: {} }
      expect(event.type).toBe('test')

      // ReconnectConfig
      const reconnect: ReconnectConfig = {
        enabled: true,
        initialDelay: 500,
        maxDelay: 30000,
        backoffMultiplier: 2,
        maxAttempts: 10,
      }
      expect(reconnect.enabled).toBe(true)

      // SSEStatus
      const status: SSEStatus = {
        connected: false,
        connecting: true,
        error: null,
        reconnectAttempt: 0,
      }
      expect(status.connecting).toBe(true)

      // EventMapping
      const mapping: EventMapping<{ id: number }, unknown> = {
        key: '/api/items',
        update: 'set',
      }
      expect(mapping.key).toBe('/api/items')

      // UpdateStrategy
      const strategy: UpdateStrategy<string, string[]> = (current, payload) => [
        ...(current ?? []),
        payload,
      ]
      expect(typeof strategy).toBe('function')

      // SSEProviderProps
      const props: SSEProviderProps = {
        config: { url: '/events', events: {} },
        children: null,
      }
      expect(props.config.url).toBe('/events')
    })
  })
})
