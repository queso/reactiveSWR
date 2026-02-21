import type { SchemaDefinition, SchemaResult } from './types.ts'

/**
 * Define a shared, frozen schema object consumed by both createChannel() (server)
 * and SSEProvider (client).
 *
 * Event names are preserved as string literal keys for full TypeScript inference
 * and autocomplete. The `update` property defaults to `'set'` when not specified.
 *
 * @example
 * ```ts
 * const schema = defineSchema({
 *   'user.updated': { key: '/api/users', update: 'set' },
 *   'order.placed': { key: (p: { id: string }) => `/api/orders/${p.id}` },
 * })
 * ```
 */
export function defineSchema<T extends SchemaDefinition>(
  definition: T,
): SchemaResult<T> {
  const result: Record<string, unknown> = {}

  for (const eventName of Object.keys(definition)) {
    const def = definition[eventName]
    result[eventName] = {
      ...def,
      update: def?.update ?? 'set',
    }
  }

  return Object.freeze(result) as SchemaResult<T>
}
