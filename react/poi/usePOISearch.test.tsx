/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Direct hook test for `usePOISearch` — driven through a tiny harness with a mock taxonomy runtime
 *   and a mock live probe. Exercises the abstain branch (POI kind, no lexicon hit) and the full
 *   subject → live-search path.
 */

import { userEvent } from "@vitest/browser/context"
import type { ReactNode } from "react"
import { expect, test, vi } from "vitest"

import { makePOIRuntime, mockLiveSearchSuccess } from "../test/mocks.tsx"
import { renderComponent } from "../test/render.tsx"
import { usePOISearch } from "./usePOISearch.ts"

// Stable module-level loader so the Harness passes the same closure every render.
const loadRuntime = async () => makePOIRuntime()

function Harness({ text }: { text: string }): ReactNode {
	const { result, liveSearch, canSearchLive, searchLive } = usePOISearch({
		text,
		loadRuntime,
		runLiveSearch: mockLiveSearchSuccess,
		debounceMs: 0,
	})

	return (
		<div>
			<span className="subject">{result?.subject?.category.label ?? "no-subject"}</span>
			<span className="live">{liveSearch.status}</span>
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
