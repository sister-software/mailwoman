/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { expect, test } from "vitest"

import { renderComponent } from "../test/render.tsx"
import { ResolvedPlace } from "./ResolvedPlace.tsx"

const PLACE = { id: 85977539, name: "New York", placetype: "locality", lat: 40.7128, lon: -74.006, score: 0.82 }

test("ResolvedPlace lists the place's fields", () => {
	const { container } = renderComponent(<ResolvedPlace place={PLACE} />)

	expect(container.textContent).toContain("New York")
	expect(container.textContent).toContain("locality")
	expect(container.textContent).toContain("85977539")
	expect(container.textContent).toContain("40.7128")
	expect(container.querySelector(".mw-resolved__dual")).toBeNull()
})

test("ResolvedPlace renders the dual-role note when roles are present", () => {
	const { container } = renderComponent(
		<ResolvedPlace
			place={PLACE}
			dualRoles={[{ id: 1, name: "New York", placetype: "region", relationshipType: "city-state", role: "region" }]}
		/>
	)

	const note = container.querySelector(".mw-resolved__dual")
	expect(note?.textContent).toContain("Dual-role")
	expect(note?.textContent).toContain("city state")
})
