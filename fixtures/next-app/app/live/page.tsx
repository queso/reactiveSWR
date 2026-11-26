'use client'

// Issue #6: prerendering this page failed `next build` in 0.2.0 with
// "jsxDEV is not a function", because the published bundle used the
// development JSX runtime.
import { SSEProvider, useSSEStatus } from 'reactive-swr'
import { SWRConfig } from 'swr'
import { schema } from '@/lib/schema'

function Status() {
  const status = useSSEStatus()
  return <p>connected: {String(status.connected)}</p>
}

export default function LivePage() {
  return (
    <SWRConfig value={{ fetcher: (url: string) => fetch(url).then((r) => r.json()) }}>
      <SSEProvider config={{ url: '/api/events', schema }}>
        <Status />
      </SSEProvider>
    </SWRConfig>
  )
}
