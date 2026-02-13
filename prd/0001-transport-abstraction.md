# PRD-0001: Transport Abstraction

**Author:** Josh
**Date:** 2026-02-12
**Status:** Draft

## Problem Statement

`useSSEStream` and `SSEProvider` hardcode `new EventSource(url)`, which only supports GET requests. Real-world SSE use cases frequently require POST with a JSON body (e.g., sending a query payload and streaming results back). This was discovered during integration testing with [ArcaneLayers/data-ops](https://github.com/ArcaneLayers/data-ops), where the `/api/query` endpoint requires POST with `{ question, shop, stream }` in the body.

This is the single biggest blocker to adopting reactiveSWR in apps that don't use vanilla GET-based SSE.

## Business Context

- **Adoption blocker:** Without POST support, the library is limited to GET-only SSE, which excludes a large class of real-world use cases — any endpoint that needs structured input (search queries, filters, authentication tokens in the body).
- **Timing:** At v0.0.1 this is a non-breaking API addition. After npm publish and wider adoption, adding it becomes a harder sell and risks breaking changes.
- **Competitive gap:** Libraries like `eventsource-parser` and hand-rolled `fetch` + `ReadableStream` solutions are what developers fall back to today. Built-in POST support makes reactiveSWR a complete solution.
- **Mechanical change:** The core library change is small — the internal transport selection is automatic based on what options the developer provides. The risk is low and the payoff is high.

## Goals & Success Metrics

| Goal | Metric | Target |
|------|--------|--------|
| Enable POST-based SSE | Developers can pass `method`, `body`, `headers` to stream from POST endpoints | Works with any `fetch()`-compatible SSE endpoint |
| Zero-config for GET | Apps that don't pass `method`/`body`/`headers` behave identically to today | 100% existing test pass rate, zero API changes for current users |
| Simple API | No transport classes or factories in the common case | Developer adds `method: 'POST'` and `body` — done |
| Maintain bundle size | Library stays lightweight | < 1KB additional gzipped |

**Negative metric:** Existing `EventSource`-based usage shall not degrade in performance or behavior.

## User Stories

- **As a** developer with a POST-based SSE endpoint, **I want** to pass `method`, `body`, and `headers` to `useSSEStream` **so that** I can stream results from endpoints that require structured input — without learning a transport API.
- **As a** developer using the default GET-based SSE, **I want** the library to work exactly as before **so that** I don't need to change anything when upgrading.
- **As a** developer writing tests, **I want** `mockSSE` to work with both GET and POST streams **so that** I can test components regardless of how they connect.
- **As a** developer with a non-standard streaming backend, **I want** an escape hatch to provide my own transport **so that** I'm not limited to EventSource and fetch.

## Scope

### In Scope

- `method`, `body`, and `headers` options on `useSSEStream` and `SSEConfig`
- Automatic transport selection: use native `EventSource` for plain GET (default), use `fetch()` + `ReadableStream` when `method`, `body`, or `headers` are provided
- Internal SSE line parsing for the fetch-based path (the `data: ...\n\n` wire format)
- Reconnection support for the fetch-based path (same backoff behavior as existing EventSource reconnection)
- `SSETransport` interface exported for advanced users who need a fully custom transport (escape hatch)
- Optional `transport` override in `useSSEStream` options and `SSEConfig` for the escape hatch case
- Updated `mockSSE` test utility to work with both transport paths
- Tests for POST-based SSE streams

### Out of Scope

- WebSocket transport (different protocol entirely, separate PRD if needed)
- Server-side SSE implementation or server helpers
- Polyfills for `ReadableStream` in older browsers
- Streaming JSON parsing beyond the SSE wire format (`data:`, `event:`, `id:`, `retry:`)

## Requirements

### Functional Requirements

1. `UseSSEStreamOptions` shall accept optional `method`, `body`, and `headers` properties for configuring the HTTP request.
2. `SSEConfig` shall accept optional `method`, `body`, and `headers` properties for configuring the HTTP request.
3. When any of `method`, `body`, or `headers` are provided, the library shall internally use `fetch()` + `ReadableStream` instead of `EventSource` to establish the SSE connection. This includes `headers` alone (e.g., for authenticated GET streams that `EventSource` cannot support).
4. When none of `method`, `body`, or `headers` are provided, the library shall use native `EventSource` (preserving current default behavior).
5. If `body` is provided without `method`, the library shall default to `POST`.
6. The fetch-based path shall parse the SSE wire format (`data: ...\n\n`) from the response stream and dispatch events through the same handler interface as `EventSource`.
7. The fetch-based path shall support named SSE events (the `event:` field) and dispatch them correctly.
8. The fetch-based path shall support automatic reconnection with the same backoff behavior as the existing `EventSource` reconnection logic.
9. The fetch-based path shall track the last received `id:` field and send it as the `Last-Event-ID` header on reconnection, matching native `EventSource` behavior.
9. The library shall export an `SSETransport` interface as an escape hatch for fully custom transports. This interface shall include: `onmessage`, `onerror`, `onopen` handler properties; `close()` method; `readyState` property; and `addEventListener`/`removeEventListener` methods.
10. `UseSSEStreamOptions` and `SSEConfig` shall accept an optional `transport` property `(url: string) => SSETransport`. When provided, it shall take precedence over both `EventSource` and the fetch-based path.
11. The `mockSSE` test utility shall work with both the EventSource and fetch-based transport paths.

### Non-Functional Requirements

1. The fetch-based transport shall add no more than 1KB gzipped to the bundle.
2. SSE line parsing shall handle standard SSE fields: `data`, `event`, `id`, and `retry`.
3. All new public types shall be fully typed with TypeScript and exported from the package entry point.

## Edge Cases & Error States

- **Malformed SSE lines:** The fetch-based path shall skip lines that don't conform to the SSE format (no `:`), matching browser `EventSource` behavior.
- **Multi-line `data` fields:** SSE allows multiple consecutive `data:` lines before `\n\n`. The parser shall concatenate them with `\n` (per the SSE spec).
- **Empty `data` field:** `data:\n\n` (empty string) shall dispatch an event with empty string data, not be skipped.
- **Network error during fetch:** The fetch-based path shall invoke `onerror` and, if reconnection is enabled, schedule a retry.
- **Response with non-200 status:** Non-2xx responses shall be treated as errors and invoke `onerror`.
- **AbortController cleanup:** `close()` on the fetch-based transport shall abort the underlying fetch request and clean up the `ReadableStream` reader.
- **Stream ends unexpectedly:** If the server closes the stream, the fetch-based path shall treat it as a disconnect and attempt reconnection if enabled.
- **Custom transport throws:** If a user-provided `transport` factory throws, `SSEProvider` and `useSSEStream` shall catch the error and report it via the existing error handling path.
- **`body` without `method`:** The library shall default to `POST`.
- **`headers` without `method` or `body`:** The library shall use the fetch-based path with `GET`. This enables authenticated SSE streams with custom headers — something `EventSource` cannot do.

## Dependencies

- **Internal:** Existing `SSEProvider` and `useSSEStream` implementations (both need updates to accept request options)
- **Internal:** `mockSSE` test utility (needs updates to support fetch-based connections)
- **Browser API:** `fetch()` and `ReadableStream` (available in all modern browsers, Node 18+)
- **No new external dependencies**

## Risks & Open Questions

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| `ReadableStream` not available in target environment | Low | Fetch-based path unusable | Document browser/runtime requirements; default path remains EventSource |
| SSE line parsing edge cases | Medium | Incorrect event dispatch | Follow the [WHATWG SSE spec](https://html.spec.whatwg.org/multipage/server-sent-events.html#event-stream-interpretation) for parsing; test against known edge cases |
| Breaking change to mockSSE | Low | Existing tests fail | Ensure mockSSE changes are backwards-compatible |

### Open Questions

None — all resolved.
