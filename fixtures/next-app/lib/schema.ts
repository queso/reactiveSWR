// The shared schema. Imported by a route handler (server) and by a client
// page, so it must come from an entry that loads neither react nor swr.
import { defineSchema } from 'reactive-swr/schema'

export const schema = defineSchema({
  'order.placed': { key: '/api/orders', update: 'refetch' },
  'order.updated': {
    key: (p: { id: string }) => `/api/orders/${p.id}`,
    update: 'set',
  },
})

// Type check of the published declarations. If `reactive-swr/schema` stopped
// resolving its types, `schema` would be `any` and the line below would no
// longer be an error, which fails `next build`.
// @ts-expect-error 'order.cancelled' is not an event of this schema
export const missing = schema['order.cancelled']
