/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { expect, test } from "vitest"

import { renderComponent } from "../test/render.tsx"
import { KindBadge } from "./KindBadge.tsx"

test("KindBadge shows the top kind + confidence and lists alternatives", () => {
	const { container } = renderComponent(
		<KindBadge
			kindResult={{
				kind: "poi_query",
				confidence: 0.92,
				alternatives: [{ kind: "structured_address", confidence: 0.3 }],
			}}
		/>
	)

	expect(container.textContent).toContain("poi_query")
	expect(container.textContent).toContain("92%")

	const alternatives = container.querySelectorAll(".mw-kind__alternatives li")
	expect(alternatives).toHaveLength(1)
	expect(alternatives[0]?.textContent).toContain("structured_address")
})

test("KindBadge omits the alternatives list when there are none", () => {
	const { container } = renderComponent(
		<KindBadge kindResult={{ kind: "postcode_only", confidence: 1, alternatives: [] }} />
	)

	expect(container.querySelector(".mw-kind__alternatives")).toBeNull()
})
