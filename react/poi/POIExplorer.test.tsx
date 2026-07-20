/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Composed test: the whole POI explorer (ClientOnly → usePOISearch → presentational units) against a
 *   mock taxonomy runtime + mock live probe — no taxonomy load, no httpvfs.
 */

import { userEvent } from "@vitest/browser/context"
import { expect, test, vi } from "vitest"

import { makePOIRuntime, mockLiveSearchSuccess } from "../test/mocks.tsx"
import { renderComponent } from "../test/render.tsx"
import { POIExplorer } from "./POIExplorer.tsx"

test("detects a POI subject and runs an injected live search", async () => {
	const { container } = renderComponent(
		<POIExplorer
			defaultText="drinking fountain near Springfield"
			loadRuntime={async () => makePOIRuntime()}
			runLiveSearch={mockLiveSearchSuccess}
		/>
	)

	await vi.waitFor(() => expect(container.querySelector(".mw-subject__chip")?.textContent).toBe("Drinking Fountain"), {
		timeout: 3000,
	})

	const liveButton = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("Search live"))
	expect(liveButton).toBeTruthy()

	await userEvent.click(liveButton as HTMLButtonElement)
	await vi.waitFor(() => expect(container.textContent).toContain("Washington Park Fountain"))
})

test("omits the live-results affordance when no probe is injected", async () => {
	const { container } = renderComponent(
		<POIExplorer defaultText="drinking fountain near Springfield" loadRuntime={async () => makePOIRuntime()} />
	)

	await vi.waitFor(() => expect(container.querySelector(".mw-subject__chip")).toBeTruthy(), { timeout: 3000 })
	expect([...container.querySelectorAll("button")].some((b) => b.textContent?.includes("Search live"))).toBe(false)
})
