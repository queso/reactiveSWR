import { describe, expect, it } from 'bun:test'
import type {
  EventMapping,
  ParsedEvent,
  ReconnectConfig,
  SSEConfig,
  SSEProviderProps,
  SSEStatus,
  UpdateStrategy,
} from '../types.ts'

/**
 * Type-level tests for reactiveSWR public API types.
 *
 * These tests verify that:
 * 1. All types are exported and importable
 * 2. Required fields are enforced (via @ts-expect-error)
 * 3. Generics constrain correctly
 *
 * The tests should FAIL until src/types.ts is implemented.
 */

describe('reactiveSWR types', () => {
  it('should enforce required fields on SSEConfig and accept valid config', () => {
    // Valid SSEConfig with all required fields
    const validConfig: SSEConfig = {
      url: 'http://localhost:3000/events',
      events: {
        'user.updated': {
          key: '/api/user',
        },
      },
    }
    expect(validConfig.url).toBe('http://localhost:3000/events')

    // @ts-expect-error - SSEConfig requires 'url' field
    const _missingUrl: SSEConfig = {
      events: {},
    }

    // @ts-expect-error - SSEConfig requires 'events' field
    const _missingEvents: SSEConfig = {
      url: 'http://localhost:3000/events',
    }

    // Valid config with all optional fields populated
    const fullConfig: SSEConfig = {
      url: 'http://localhost:3000/events',
      events: {},
      parseEvent: (event: MessageEvent) => ({
        type: 'test',
        payload: event.data,
      }),
      onConnect: () => {},
      onError: (_error: Event) => {},
      onDisconnect: () => {},
      reconnect: { enabled: true, initialDelay: 500 },
      debug: true,
      onEventError: (_event: ParsedEvent, _error: unknown) => {},
    }
    expect(fullConfig.debug).toBe(true)

    // SSEStatus requires all fields
    const status: SSEStatus = {
      connected: true,
      connecting: false,
      error: null,
      reconnectAttempt: 0,
    }
    expect(status.connected).toBe(true)

    // ParsedEvent requires type and payload
    const event: ParsedEvent = { type: 'test', payload: { id: 1 } }
    expect(event.type).toBe('test')

    // @ts-expect-error - ParsedEvent requires 'type' field
    const _badEvent: ParsedEvent = { payload: 'data' }

    // ReconnectConfig - all fields are optional, empty object is valid
    const emptyReconnect: ReconnectConfig = {}
    expect(emptyReconnect).toBeDefined()
  })

  it('should support all UpdateStrategy variants in EventMapping', () => {
    // UpdateStrategy as 'set' literal
    const setMapping: EventMapping<
      { id: number },
      { id: number; name: string }
    > = {
      key: '/api/items',
      update: 'set',
    }
    expect(setMapping.update).toBe('set')

    // UpdateStrategy as 'refetch' literal
    const refetchMapping: EventMapping<
      { id: number },
      { id: number; name: string }
    > = {
      key: '/api/items',
      update: 'refetch',
    }
    expect(refetchMapping.update).toBe('refetch')

    // UpdateStrategy as custom merge function
    const mergeMapping: EventMapping<
      { id: number; name: string },
      { id: number; name: string }[]
    > = {
      key: (payload) => `/api/items/${payload.id}`,
      update: (current, payload) => [...(current ?? []), payload],
      filter: (payload) => payload.id > 0,
      transform: (payload) => ({ ...payload, transformed: true }),
    }
    expect(typeof mergeMapping.update).toBe('function')

    // EventMapping key can be string, string[], or function
    const arrayKeyMapping: EventMapping<unknown, unknown> = {
      key: ['/api/users', '/api/teams'],
    }
    expect(Array.isArray(arrayKeyMapping.key)).toBe(true)
  })

  it('should type SSEProviderProps with config and children', () => {
    // SSEProviderProps should have config (SSEConfig) and children (React.ReactNode)
    const props: SSEProviderProps = {
      config: {
        url: 'http://localhost:3000/events',
        events: {},
      },
      children: null,
    }
    expect(props.config.url).toBe('http://localhost:3000/events')

    // @ts-expect-error - SSEProviderProps requires config
    const _noConfig: SSEProviderProps = {
      children: null,
    }

    // Verify UpdateStrategy type alias works standalone
    const strategySet: UpdateStrategy<string, string> = 'set'
    const strategyRefetch: UpdateStrategy<string, string> = 'refetch'
    const strategyFn: UpdateStrategy<string, string[]> = (current, payload) => [
      ...(current ?? []),
      payload,
    ]
    expect(strategySet).toBe('set')
    expect(strategyRefetch).toBe('refetch')
    expect(typeof strategyFn).toBe('function')
  })
})
