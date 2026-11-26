// Issue #7: this import chain (route handler -> channel -> schema) failed
// `next build` in 0.2.0, because the only entry carrying defineSchema was the
// package root, which loads swr's hooks.
import { channel } from '@/lib/channel'

export const dynamic = 'force-dynamic'

export function GET(request: Request) {
  return channel.connect(request)
}
