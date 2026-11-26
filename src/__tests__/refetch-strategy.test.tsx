import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createElement } from 'react'
import useSWR, { SWRConfig } from 'swr'
import { SSEProvider } from '../SSEProvider.tsx'
import { defineSchema } from '../schema.ts'
import { mockSSE } from '../testing/index.ts'
import { cleanupDom, flush, installDom, render } from './helpers/dom.ts'

/**
 * The 'refetch' strategy against a real SWR cache (issue #12).
 *
 * A refetch event must revalidate the key and leave the cached value in
 * place: data stays the previous value until the fetcher resolves,
 * isLoading stays false and isValidating goes true.
 */

const URL = '/api/events'
const KEY = '/api/list'

const schema = defineSchema({
  'list.changed': { key: KEY, update: 'refetch' },
})

interface Snapshot {
  data: string | undefined
  isLoading: boolean
  isValidating: boolean
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(check: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor timed out')
    }
    await flush(() => wait(5))
  }
}

function setup(keepPreviousData: boolean) {
  const mock = mockSSE(URL)
  const snapshots: Snapshot[] = []
  let fetchCount = 0
  let releaseSecondFetch: (value: string) => void = () => {}

  const fetcher = (): Promise<string> => {
    fetchCount += 1
    if (fetchCount === 1) return Promise.resolve('v1')
    return new Promise<string>((resolve) => {
      releaseSecondFetch = resolve
    })
  }

  function List() {
    const { data, isLoading, isValidating } = useSWR<string>(KEY, fetcher, {
      keepPreviousData,
    })
    snapshots.push({ data, isLoading, isValidating })
    return createElement('span', null, data ?? '')
  }

  render(
    createElement(
      SWRConfig,
      { value: { provider: () => new Map(), dedupingInterval: 0 } },
      createElement(
        SSEProvider,
        { config: { url: URL, schema } },
        createElement(List),
      ),
    ),
  )

  return {
    mock,
    snapshots,
    fetchCount: () => fetchCount,
    release: (value: string) => releaseSecondFetch(value),
  }
}

describe("'refetch' strategy with real SWR (#12)", () => {
  beforeEach(() => {
    installDom()
  })

  afterEach(() => {
    cleanupDom()
    mockSSE.restore()
  })

  for (const keepPreviousData of [false, true]) {
    it(`keeps data and does not set isLoading while revalidating (keepPreviousData: ${keepPreviousData})`, async () => {
      const t = setup(keepPreviousData)
      await waitFor(() => t.snapshots.at(-1)?.data === 'v1')
      const loadedAt = t.snapshots.length

      await flush(() => t.mock.sendEvent({ type: 'list.changed', payload: {} }))
      await waitFor(() => t.fetchCount() === 2)
      await flush(() => wait(10))

      const during = t.snapshots.slice(loadedAt)
      expect(during.length).toBeGreaterThan(0)
      // The previous value stays visible for every render while the fetch is pending
      expect(during.every((s) => s.data === 'v1')).toBe(true)
      expect(during.every((s) => s.isLoading === false)).toBe(true)
      expect(during.at(-1)?.isValidating).toBe(true)

      await flush(() => t.release('v2'))
      await waitFor(() => t.snapshots.at(-1)?.data === 'v2')

      const last = t.snapshots.at(-1)
      expect(last?.isLoading).toBe(false)
      expect(last?.isValidating).toBe(false)
    })
  }
})
