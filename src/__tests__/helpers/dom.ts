/**
 * Client-side rendering for tests that need effects to run.
 *
 * renderToString runs no effects, so it cannot observe anything SSEProvider
 * does in useEffect (opening the connection, attaching the visibility
 * listener). `render` mounts into a happy-dom document with react-dom/client
 * and flushes effects through act().
 *
 * Call `installDom()` before rendering and `cleanupDom()` in afterEach. Only
 * `window` and `document` are installed, so Bun's own fetch, Request,
 * Response and EventSource globals are left alone. `window` stays installed
 * for the rest of the process once set, because React DOM reads
 * `window.event` when it schedules an update, which can happen after a test
 * ends (a status update from a connection callback). `document` is set only
 * while a test runs and only when the test has not installed its own.
 */

import { Window } from 'happy-dom'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'

// React warns about any state update outside act() while
// IS_REACT_ACT_ENVIRONMENT is true, and warns about act() itself while it is
// not. These tests fire connection callbacks outside act() on purpose (to
// mirror the browser), so the flag is set only for the duration of each act().
const reactGlobals = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }

/** Run `fn` inside act() and flush the updates and effects it causes. */
export function actSync(fn: () => void): void {
  reactGlobals.IS_REACT_ACT_ENVIRONMENT = true
  try {
    act(fn)
  } finally {
    reactGlobals.IS_REACT_ACT_ENVIRONMENT = false
  }
}

interface Mounted {
  root: Root
  container: HTMLElement
}

const mounted: Mounted[] = []
let happyWindow: Window | null = null
let installedDocument = false

/** Install the happy-dom window, and its document unless a test set its own. */
export function installDom(): void {
  // biome-ignore lint/suspicious/noExplicitAny: swapping globals for tests
  const g = globalThis as any
  if (happyWindow === null) {
    happyWindow = new Window()
    g.window = happyWindow
  }
  if (g.document === undefined) {
    g.document = happyWindow.document
    installedDocument = true
  }
}

/** Mount `element` and run its effects. Returns a function that unmounts it. */
export function render(element: ReactNode): { unmount: () => void } {
  installDom()
  // Always mount into the happy-dom document, even when a test replaced
  // globalThis.document with its own mock for visibility events.
  const doc = (happyWindow as Window).document
  const container = doc.createElement('div') as unknown as HTMLElement
  doc.body.appendChild(container as unknown as Node as never)
  const root = createRoot(container)
  actSync(() => {
    root.render(element)
  })
  const entry = { root, container }
  mounted.push(entry)
  return {
    unmount: () => {
      const index = mounted.indexOf(entry)
      if (index === -1) return
      mounted.splice(index, 1)
      actSync(() => {
        root.unmount()
      })
    },
  }
}

/** Run `fn` inside act() so state updates and effects it causes are flushed. */
export async function flush(fn: () => void | Promise<void>): Promise<void> {
  reactGlobals.IS_REACT_ACT_ENVIRONMENT = true
  try {
    await act(async () => {
      await fn()
    })
  } finally {
    reactGlobals.IS_REACT_ACT_ENVIRONMENT = false
  }
}

/** Unmount everything `render` mounted and remove the document installDom set. */
export function cleanupDom(): void {
  while (mounted.length > 0) {
    const entry = mounted.pop() as Mounted
    actSync(() => {
      entry.root.unmount()
    })
    entry.container.remove()
  }
  // biome-ignore lint/suspicious/noExplicitAny: restoring globals for tests
  const g = globalThis as any
  if (installedDocument && g.document === happyWindow?.document) {
    g.document = undefined
  }
  installedDocument = false
}
