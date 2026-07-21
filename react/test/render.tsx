/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   A minimal React render harness for the browser-mode tests — `createRoot` into a fresh container,
 *   plus a `cleanup` that unmounts everything. Kept dependency-light (no @testing-library) since the
 *   components are small and `@vitest/browser/context` provides the querying + interaction API.
 */

import { type ReactElement } from "react"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"

/**
 * How long `cleanup` drains pending async work — inside act() — before unmounting. Catches the trailing `setState` a
 * test leaves in flight: an autocomplete debounce (10 ms) scheduled by the final pick, a secondary parse/runtime
 * promise that lands just after the last assertion resolved. Draining these in an act scope is what keeps them from
 * logging "not wrapped in act(...)" in the window between a test returning and this `afterEach` running. 25 ms clears
 * the 10 ms debounce with margin; the clipboard reset (1500 ms) is instead cleared by `useClipboard`'s unmount effect,
 * so it needs no drain here.
 */
const CLEANUP_DRAIN_MS = 25

const mounted: Array<{ root: Root; container: HTMLElement }> = []

export interface RenderResult {
	container: HTMLElement
}

export function renderComponent(ui: ReactElement): RenderResult {
	const container = document.createElement("div")
	document.body.appendChild(container)
	const root = createRoot(container)

	act(() => {
		root.render(ui)
	})
	mounted.push({ root, container })

	return { container }
}

export async function cleanup(): Promise<void> {
	const trees = mounted.splice(0)

	if (trees.length === 0) return

	// Drain any trailing async update INSIDE act() so a still-pending debounce/promise settles in-scope
	// rather than firing unwrapped in the gap before unmount.
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, CLEANUP_DRAIN_MS))
	})

	for (const { root, container } of trees) {
		act(() => root.unmount())
		container.remove()
	}
}
