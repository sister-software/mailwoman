/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { POISubject } from "@mailwoman/react/poi/types"
import { usePOISearch } from "@mailwoman/react/poi/usePOISearch"
import type { ReactNode } from "react"
import { expect, test, vi } from "vitest"
import { userEvent } from "vitest/browser"

import { makeBrandPOIRuntime, makePOIRuntime, mockBrandLiveSearchSuccess, mockLiveSearchSuccess } from "../../mocks.tsx"
import { renderComponent } from "../../render.tsx"

// The loaders are module constants so the harness passes the same reference on every render.
const loadRuntime = async () => makePOIRuntime()
const loadBrandRuntime = async () => makeBrandPOIRuntime()

function subjectLabel(subject: POISubject | undefined): string {
	if (!subject) return "no-subject"

	return subject.kind === "brand" ? subject.name : subject.category.label
}

function Harness({
	text,
	loader = loadRuntime,
	runLiveSearch = mockLiveSearchSuccess,
	brandLiveSearch = false,
}: {
	text: string
	loader?: () => Promise<Awaited<ReturnType<typeof makePOIRuntime>>>
	runLiveSearch?: typeof mockLiveSearchSuccess
	brandLiveSearch?: boolean
}): ReactNode {
	const { result, liveSearch, canSearchLive, searchLive } = usePOISearch({
		text,
		loadRuntime: loader,
		runLiveSearch,
		brandLiveSearch,
		debounceMs: 0,
	})

	return (
		<div>
			<span className="subject">{subjectLabel(result?.subject)}</span>
			<span className="live">{liveSearch.status}</span>
			<span className="hit">{liveSearch.status === "success" ? (liveSearch.hits[0]?.name ?? "") : ""}</span>
			<button type="button" onClick={searchLive} disabled={!canSearchLive}>
				go
			</button>
		</div>
	)
}

test("a POI kind with no lexicon hit yields no subject (abstain)", async () => {
	const { container } = renderComponent(<Harness text="hospital" />)

	await vi.waitFor(() => expect(container.querySelector(".subject")?.textContent).toBe("no-subject"), { timeout: 2000 })
})

test("a matched subject enables live search, which resolves to success", async () => {
	const { container } = renderComponent(<Harness text="drinking fountain, Springfield" />)

	await vi.waitFor(() => expect(container.querySelector(".subject")?.textContent).toBe("Drinking Fountain"), {
		timeout: 2000,
	})

	const button = container.querySelector("button") as HTMLButtonElement
	expect(button.disabled).toBe(false)

	await userEvent.click(button)
	await vi.waitFor(() => expect(container.querySelector(".live")?.textContent).toBe("success"))
})

test("a brand subject stays intent-only when the probe isn't brand-capable (no live affordance)", async () => {
	const { container } = renderComponent(
		<Harness text="chevron near Houston" loader={loadBrandRuntime} runLiveSearch={mockBrandLiveSearchSuccess} />
	)

	await vi.waitFor(() => expect(container.querySelector(".subject")?.textContent).toBe("Chevron"), { timeout: 2000 })
	// `brandLiveSearch` defaults to false, so live search stays disabled.
	expect((container.querySelector("button") as HTMLButtonElement).disabled).toBe(true)
})

test("a brand subject with a brand-capable probe threads the QID into the live search", async () => {
	const { container } = renderComponent(
		<Harness
			text="chevron near Houston"
			loader={loadBrandRuntime}
			runLiveSearch={mockBrandLiveSearchSuccess}
			brandLiveSearch
		/>
	)

	await vi.waitFor(() => expect(container.querySelector(".subject")?.textContent).toBe("Chevron"), { timeout: 2000 })

	const button = container.querySelector("button") as HTMLButtonElement
	expect(button.disabled).toBe(false)

	await userEvent.click(button)
	await vi.waitFor(() => expect(container.querySelector(".live")?.textContent).toBe("success"))
	// The mock probe echoes the QID it received, which shows that `usePOISearch` passed `brandWikidata`.
	expect(container.querySelector(".hit")?.textContent).toContain("Q319642")
})
