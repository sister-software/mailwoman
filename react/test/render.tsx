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

export function cleanup(): void {
	for (const { root, container } of mounted.splice(0)) {
		act(() => root.unmount())
		container.remove()
	}
}
