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
 * Response and EventSource globals are left alone.
 */

import { Window } from 'happy-dom'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'

// Tell React this is a test environment so act() flushes effects without warnings
const reactGlobals = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
reactGlobals.IS_REACT_ACT_ENVIRONMENT = true

interface Mounted {
  root: Root
  container: HTMLElement
}

const mounted: Mounted[] = []
let happyWindow: Window | null = null
let savedWindow: unknown
let savedDocument: unknown
let installed = false

/** Install a happy-dom window and document unless a test already set its own document. */
export function installDom(): void {
  if (installed) return
  // biome-ignore lint/suspicious/noExplicitAny: swapping globals for tests
  const g = globalThis as any
  savedWindow = g.window
  savedDocument = g.document
  happyWindow = new Window()
  g.window = happyWindow
  if (g.document === undefined) {
    g.document = happyWindow.document
  }
  installed = true
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
  act(() => {
    root.render(element)
  })
  const entry = { root, container }
  mounted.push(entry)
  return {
    unmount: () => {
      const index = mounted.indexOf(entry)
      if (index === -1) return
      mounted.splice(index, 1)
      act(() => {
        root.unmount()
      })
    },
  }
}

/** Run `fn` inside act() so state updates and effects it causes are flushed. */
export function flush(fn: () => void | Promise<void>): Promise<void> {
  return act(async () => {
    await fn()
  })
}

/** Unmount everything `render` mounted and restore the globals installDom replaced. */
export function cleanupDom(): void {
  while (mounted.length > 0) {
    const entry = mounted.pop() as Mounted
    act(() => {
      entry.root.unmount()
    })
  }
  if (!installed) return
  // biome-ignore lint/suspicious/noExplicitAny: restoring globals for tests
  const g = globalThis as any
  g.window = savedWindow
  if (g.document === happyWindow?.document) {
    g.document = savedDocument
  }
  happyWindow?.close()
  happyWindow = null
  installed = false
}
