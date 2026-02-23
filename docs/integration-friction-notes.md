# reactiveSWR Integration Friction Log

Friction points encountered while integrating `reactive-swr` (linked from `/Users/josh/Code/OpenSource/reactiveSWR/`) into `data-ops` via PRD-0003.

---

## 1. dist/testing/index.d.ts must be hand-written

**Severity:** bug

**Description:** The `src/testing/index.ts` module cannot be compiled by `tsc --emitDeclarationOnly` because it assigns a mock function to `globalThis.fetch` that is missing the `preconnect` property added in Node 24's `@types/node` fetch type. This blocks `.d.ts` generation for the entire `./testing` export path.

**Reproduction:**
```bash
cd /path/to/reactiveSWR
npx tsc --declaration --emitDeclarationOnly --outDir dist --rootDir src \
  --jsx react-jsx --module esnext --moduleResolution bundler \
  --target esnext --strict --skipLibCheck --noEmit false \
  --allowImportingTsExtensions \
  src/index.ts src/testing/index.ts
```
```
src/testing/index.ts(186,5): error TS2741: Property 'preconnect' is missing
in type '(input: URL | RequestInfo, init?: RequestInit) => Promise<Response>'
but required in type 'typeof fetch'.
```

**Workaround:** Hand-write `dist/testing/index.d.ts` with the exported types (`mockSSE`, `MockSSEControls`, `SSEEventData`). This is fragile and will drift from the source.

**Suggested fix:** Cast the mock fetch assignment in `src/testing/index.ts`:
```typescript
globalThis.fetch = function mockFetch(...) { ... } as typeof globalThis.fetch
```
Or add a `preconnect` stub to the mock.

---

## 2. dist/ must be built before linking

**Severity:** friction

**Description:** When a consumer adds `reactive-swr` via `link:` protocol, the `dist/` directory must already contain compiled output. There is no `prepare` or `preinstall` script in `package.json` that builds automatically. A consumer who clones and links gets a broken package with missing `dist/index.js`.

**Reproduction:**
```bash
# In reactiveSWR directory with no dist/
cd /path/to/consumer
pnpm add reactive-swr@link:/path/to/reactiveSWR
# Import fails: Cannot find module 'reactive-swr'
```

**Workaround:** Manually run `bun run build` in the reactiveSWR directory before linking.

**Suggested fix:** Add a `prepare` script to reactiveSWR's `package.json`:
```json
"scripts": {
  "prepare": "bun run build"
}
```

---

## 3. .d.ts generation requires a separate tsc step

**Severity:** friction

**Description:** `bun run build` (which runs `bun build src/index.ts --outdir dist --target browser`) generates JavaScript bundles but does not emit TypeScript declaration files. The `tsconfig.json` has `"noEmit": true`, so there is no built-in way to produce `.d.ts` files. A separate `tsc` invocation with a custom config is required.

Additionally, the build script only bundles `src/index.ts` -- it does not build the `./testing` subpath (`src/testing/index.ts`), which must be built with a second `bun build` command.

**Reproduction:**
```bash
cd /path/to/reactiveSWR
bun run build
ls dist/
# Only index.js -- no .d.ts files, no testing/ directory
```

**Workaround:** Create a temporary `tsconfig.emit.json` that extends the base config with `declaration: true, emitDeclarationOnly: true, noEmit: false`, then run:
```bash
npx tsc -p tsconfig.emit.json    # generates .d.ts for main exports
bun build src/testing/index.ts --outdir dist/testing  # build testing JS
# hand-write dist/testing/index.d.ts (see friction point #1)
```

**Suggested fix:** Add a `build:types` script and update the main `build` script:
```json
"scripts": {
  "build": "bun build src/index.ts --outdir dist --target browser --external react --external react-dom --external swr && bun build src/testing/index.ts --outdir dist/testing --target browser && npm run build:types",
  "build:types": "tsc -p tsconfig.emit.json"
}
```

---

## 4. Vitest resolve aliases required for linked packages

**Severity:** bug

**Description:** When `reactive-swr` is linked via `link:` protocol, its bundled `dist/index.js` resolves `react`, `react-dom`, and `swr` to the copies in `reactiveSWR/node_modules/` rather than `data-ops/node_modules/`. This causes the "Invalid hook call -- multiple copies of React" error because React context (used by `useSWRConfig()` and `useContext()`) is not shared across instances.

Even with `--external react --external react-dom --external swr` flags during bun build, the symlink causes Node's module resolution to find the wrong copies.

**Reproduction:**
```bash
# In data-ops with reactive-swr linked
npx vitest run app/__tests__/providers.test.tsx
# TypeError: Cannot read properties of null (reading 'useContext')
# Invalid hook call. You might have more than one copy of React
```

**Workaround:** Add resolve aliases in `vitest.config.ts`:
```typescript
resolve: {
  alias: {
    'react': path.resolve(__dirname, 'node_modules/react'),
    'react-dom': path.resolve(__dirname, 'node_modules/react-dom'),
    'swr': path.resolve(__dirname, 'node_modules/swr'),
  },
},
```

**Suggested fix:** This is a fundamental issue with `link:` protocol and bundled libraries. Options:
1. Mark `react`, `react-dom`, `swr` as `peerDependencies` only (already done) AND ensure the build uses `--external` flags (not done in the default build script).
2. Publish to npm instead of using `link:` protocol.
3. Use the `module` field (`"module": "src/index.ts"`) to import source directly, bypassing the bundle entirely.

---

## 5. createSSEParser used instead of useSSEStream for imperative pattern

**Severity:** suggestion

**Description:** The `useSSEStream` hook assumes a declarative, render-driven pattern where the SSE connection is managed by the hook's lifecycle. In `data-ops`, query execution is imperative: `execute(question, shop)` triggers a `POST` request, reads the SSE response, and drives a state machine. The hook's public API (`{ state, execute }`) does not fit the declarative model.

We used `createSSEParser` (the lower-level imperative API) instead, which worked well. The parser's `feed(chunk: string)` method integrates cleanly with manual `ReadableStream` consumption.

**Pattern used:**
```typescript
import { createSSEParser } from 'reactive-swr'

const parser = createSSEParser({
  onEvent(sseEvent) {
    const event = JSON.parse(sseEvent.data)
    // state machine transitions...
  },
})

const reader = response.body.getReader()
const decoder = new TextDecoder()
while (true) {
  const { done, value } = await reader.read()
  if (done) break
  parser.feed(decoder.decode(value, { stream: true }))
}
```

**Suggested improvement:** Document this imperative pattern in reactiveSWR's README as a first-class use case. Consider adding a helper like `parser.feedStream(readableStream)` that handles the ReadableStream/TextDecoder boilerplate.

---

## 6. SSEProvider requires a persistent SSE endpoint

**Severity:** friction

**Description:** `SSEProvider` connects to its configured URL on mount and maintains a persistent EventSource connection. The `data-ops` app had no pre-existing SSE endpoint -- all SSE was done per-query via `POST /api/query`. We had to create a new `GET /api/events` endpoint solely to satisfy SSEProvider's requirement for a persistent connection.

The endpoint sends a `{ type: "connected" }` event on connect and heartbeats every 30 seconds. It currently has no real-time push functionality beyond keeping the connection alive.

**Suggested improvement:** Consider supporting a "lazy" or "deferred" connection mode in SSEProvider where the connection is only established when the first event mapping or subscriber is registered, rather than immediately on mount. Alternatively, document that a minimal heartbeat endpoint is sufficient for apps that primarily use imperative patterns.

---

## 7. mockSSE requires SSE wire format via sendRaw

**Severity:** friction

**Description:** The `mockSSE` testing utility's `sendEvent()` method sends events in the `{ type, payload }` format expected by SSEProvider's default parser. However, `data-ops` sends raw SSE wire format (`data: {...}\n\n`) from its query endpoint, which the `createSSEParser` processes. Tests must use `sendRaw()` with the full SSE wire format rather than the higher-level `sendEvent()`.

**Example:**
```typescript
// Does NOT work for createSSEParser consumers:
mock.sendEvent({ type: 'complete', payload: { sql: '...' } })

// Must use sendRaw with SSE wire format:
mock.sendRaw(`data: ${JSON.stringify({ type: 'complete', sql: '...' })}\n\n`)
```

This is correct behavior (the mock faithfully simulates what the transport delivers), but it means test authors must understand the SSE wire protocol to write tests. A convenience method for the raw format could reduce friction.

**Suggested improvement:** Add a helper to the testing module:
```typescript
mockSSE.sendSSE(data: unknown) // sends `data: ${JSON.stringify(data)}\n\n`
```

---

## 8. Type safety -- no friction

**Severity:** (none -- positive note)

**Description:** Once `.d.ts` files were generated (see points #1 and #3), all TypeScript types resolved correctly. No `any` casts were needed anywhere in the integration. The `SSEConfig`, `SSEStatus`, `createSSEParser`, `useSSEStatus`, and `SSEProvider` types all integrated cleanly with the existing data-ops type system.

The `.d.ts` files generated by `tsc` contain `.ts`/`.tsx` extensions in their import paths (e.g., `from './hooks/useSSEStream.ts'`) due to `allowImportingTsExtensions` in the source config. This works with `moduleResolution: "bundler"` but would break with `moduleResolution: "node"` or `"node16"`. Worth normalizing if the package is published to npm.
