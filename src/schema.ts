import type {
  ResourceDefinition,
  SchemaDefinition,
  SchemaEventDefinition,
  SchemaResult,
} from './types.ts'

const RESOURCE_OPS = ['created', 'updated', 'deleted'] as const
type ResourceOp = (typeof RESOURCE_OPS)[number]

function expandResource(
  resourceName: string,
  resourceDef: ResourceDefinition,
): Record<string, SchemaEventDefinition> {
  const expanded: Record<string, SchemaEventDefinition> = {}

  for (const op of RESOURCE_OPS) {
    const eventName = `${resourceName}.${op}`
    const opDef = resourceDef[op as ResourceOp]

    expanded[eventName] = {
      key: opDef?.key ?? resourceName,
      ...(opDef?.update !== undefined ? { update: opDef.update } : {}),
      ...(opDef?.filter !== undefined ? { filter: opDef.filter } : {}),
      ...(opDef?.transform !== undefined ? { transform: opDef.transform } : {}),
    }
  }

  return expanded
}

/**
 * Define a shared, frozen schema object consumed by both createChannel() (server)
 * and SSEProvider (client).
 *
 * Event names are preserved as string literal keys for full TypeScript inference
 * and autocomplete. The `update` property defaults to `'set'` when not specified.
 *
 * An optional `resources` field auto-expands each resource into .created, .updated,
 * and .deleted event definitions. Explicit event definitions take precedence over
 * generated resource events.
 *
 * @example
 * ```ts
 * const schema = defineSchema({
 *   'user.updated': { key: '/api/users', update: 'set' },
 *   'order.placed': { key: (p: { id: string }) => `/api/orders/${p.id}` },
 * })
 *
 * // With resources:
 * const schema = defineSchema({
 *   resources: {
 *     orders: {
 *       updated: { key: (p: { id: string }) => `/api/orders/${p.id}` },
 *     },
 *   },
 *   'notification.sent': { key: '/api/notifications' },
 * })
 * ```
 */
export function defineSchema<T extends SchemaDefinition>(
  definition: T,
): SchemaResult<T> {
  const result: Record<string, unknown> = {}

  // First, expand resources into event triplets
  const { resources, ...explicitEvents } = definition as {
    resources?: Record<string, ResourceDefinition>
  } & Record<string, SchemaEventDefinition>

  if (resources) {
    for (const resourceName of Object.keys(resources)) {
      // Guard: empty resource names would generate malformed event keys like ".created"
      if (resourceName.trim() === '') {
        throw new Error(
          `defineSchema: resource name must be a non-empty string, got ${JSON.stringify(resourceName)}`,
        )
      }
      const expanded = expandResource(
        resourceName,
        resources[resourceName] ?? {},
      )
      for (const [eventName, eventDef] of Object.entries(expanded)) {
        result[eventName] = {
          ...eventDef,
          update: eventDef.update ?? 'set',
        }
      }
    }
  }

  // Then apply explicit events, which take precedence over any resource-generated events.
  // This is intentional: if the same key exists in both resources (expanded) and explicit events,
  // the explicit definition always wins. A warning is logged when a collision occurs.
  for (const eventName of Object.keys(explicitEvents)) {
    if (eventName in result) {
      console.warn(
        `defineSchema: explicit event "${eventName}" overrides a resource-generated event. ` +
          'The explicit definition will be used.',
      )
    }
    const def = explicitEvents[eventName]
    result[eventName] = {
      ...def,
      update: def?.update ?? 'set',
    }
  }

  return Object.freeze(result) as SchemaResult<T>
}
