# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- Transport abstraction layer for non-GET SSE connections (#WI-216, #WI-218, #WI-219, #WI-220)
- POST SSE support via `method` and `body` options in `useSSEStream` and `SSEProvider`
- Custom HTTP headers for SSE connections via `headers` option
- Custom transport factory via `transport` option for full control over SSE connections
- Automatic JSON serialization for plain object request bodies with `Content-Type: application/json`
- Body-implies-POST behavior: providing `body` without `method` defaults to POST
- `SSETransport` interface for building custom transport implementations (#WI-216)
- `SSERequestOptions` type for method/body/headers grouping (#WI-216)
- `createSSEParser` export for advanced users building custom transports (#WI-217, #WI-222)
- Spec-compliant SSE wire format parser with chunked input support (#WI-217)
- Fetch-based SSE transport using `fetch()` + `ReadableStream` (#WI-218)
- Shared reconnection utilities with exponential backoff (#WI-223)
- Unified reconnection for all transport types in SSEProvider (#WI-220)
- Composite connection keys in `useSSEStream` for proper connection reuse across different request configurations (#WI-219)
- Dual EventSource + fetch interception in `mockSSE` test utility (#WI-221)
- `sendRaw()` method on `mockSSE` controls for testing SSE parser edge cases (#WI-221)
