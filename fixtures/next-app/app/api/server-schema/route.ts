// The server entry re-exports defineSchema, so one import is enough.
import { createChannel, defineSchema } from 'reactive-swr/server'

const schema = defineSchema({
  'note.added': { key: '/api/notes', update: 'refetch' },
})
const channel = createChannel(schema)

export const dynamic = 'force-dynamic'

export function GET() {
  return Response.json({ events: Object.keys(schema), closed: channel.isClosed() })
}
