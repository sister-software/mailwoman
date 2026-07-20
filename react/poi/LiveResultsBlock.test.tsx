/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { userEvent } from "@vitest/browser/context"
import { expect, test } from "vitest"

import { renderComponent } from "../test/render.tsx"
import { LiveResultsBlock } from "./LiveResultsBlock.tsx"
import type { POISearchHit } from "./types.ts"

const HITS: POISearchHit[] = [
	{ name: "Washington Park Fountain", lat: 39.79, lon: -89.65, distanceM: 320, country: "US", confidence: 0.8 },
]

test("LiveResultsBlock disables search + prompts when there is no anchor", () => {
	const { container } = renderComponent(
		<LiveResultsBlock categoryLabel="Drinking Fountain" anchor="" state={{ status: "idle" }} onSearch={() => {}} />
	)

	expect((container.querySelector("button") as HTMLButtonElement).disabled).toBe(true)
	expect(container.querySelector(".mw-muted")?.textContent).toContain("location anchor")
})

test("LiveResultsBlock fires onSearch and renders ranked hits on success", async () => {
	let searched = false
	const { container } = renderComponent(
		<LiveResultsBlock
			categoryLabel="Drinking Fountain"
			anchor="Springfield"
			state={{ status: "success", hits: HITS, centerName: "Springfield, IL" }}
			onSearch={() => {
				searched = true
			}}
		/>
	)

	await userEvent.click(container.querySelector("button") as HTMLButtonElement)
	expect(searched).toBe(true)

	expect(container.querySelectorAll(".mw-live__results li")).toHaveLength(1)
	expect(container.textContent).toContain("Washington Park Fountain")
	expect(container.textContent).toContain("320 m")
})

test("LiveResultsBlock surfaces the error message", () => {
	const { container } = renderComponent(
		<LiveResultsBlock
			categoryLabel="Drinking Fountain"
			anchor="Nowhere"
			state={{ status: "error", message: 'couldn\'t place "Nowhere"' }}
			onSearch={() => {}}
		/>
	)

	expect(container.querySelector(".mw-error")?.textContent).toContain("couldn't place")
})
