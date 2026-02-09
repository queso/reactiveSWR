# reactiveSWR

A lightweight library that brings Meteor-style reactivity to modern React applications using SWR and Server-Sent Events (SSE).

## The Problem

Building real-time UIs typically requires:
- Manual SSE/WebSocket listeners scattered across components
- Ad-hoc cache invalidation logic
- Components tightly coupled to real-time transport details
- Easy-to-miss cache updates when data changes

## The Solution

reactiveSWR provides a declarative bridge between SSE events and SWR's cache. You define a mapping once, and your components just use normal `useSWR` hooks—they automatically receive real-time updates without knowing about SSE.

```typescript
// Define your event mappings once
const config = {
  url: '/api/events',
  events: {
    'order:updated': {
      key: (p) => `/api/orders/${p.id}`,
      update: 'set',  // Use SSE payload directly, no refetch
    },
    'comment:added': {
      key: (p) => `/api/posts/${p.postId}/comments`,
      update: (current, p) => [...(current ?? []), p.comment],
    },
  },
}

// Components just use useSWR - updates happen automatically
function OrderStatus({ orderId }) {
  const { data } = useSWR(`/api/orders/${orderId}`)
  return <div>Status: {data?.status}</div>  // Real-time!
}
```

## Key Features

- **Declarative event mapping** - Single config defines how SSE events update cached data
- **Zero component changes** - Existing `useSWR` hooks become reactive automatically
- **No extra API calls** - SSE payloads update the cache directly (when using `set` strategy)
- **Flexible update strategies** - Replace, refetch, or custom merge functions
- **TypeScript-first** - Full type safety for events and payloads
- **Lightweight** - Thin layer over SWR, no additional dependencies

## Installation

```bash
npm install reactive-swr swr
```

## Quick Start

```tsx
import { SWRConfig } from 'swr'
import { SSEProvider } from 'reactive-swr'

const sseConfig = {
  url: '/api/events',
  events: {
    'user:updated': {
      key: (p) => `/api/users/${p.id}`,
      update: 'set',
    },
  },
}

function App() {
  return (
    <SWRConfig value={{ fetcher: (url) => fetch(url).then(r => r.json()) }}>
      <SSEProvider config={sseConfig}>
        <YourApp />
      </SSEProvider>
    </SWRConfig>
  )
}
```

## Documentation

- [Specification](./docs/SPEC.md) - Detailed technical specification
- [API Reference](./docs/API.md) - Complete API documentation
- [Examples](./docs/EXAMPLES.md) - Common patterns and recipes

## Inspiration

This library is inspired by [Meteor's](https://www.meteor.com/) Minimongo and DDP protocol, which pioneered the pattern of real-time database synchronization to the client. reactiveSWR brings that developer experience to the modern React ecosystem using SSE and SWR.

## License

MIT
