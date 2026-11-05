/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { ResolvedPlace } from "@mailwoman/react/pipeline/ResolvedPlace"
import { expect, test } from "vitest"

import { renderComponent } from "../../test/render.tsx"

const PLACE = {
	id: 85_977_539,
	name: "New York",
	placetype: "locality",
	lat: 40.7128,
	lon: -74.006,
	score: 0.82,
	bbox: null,
	tier: null,
	uncertaintyM: null,
}

test("ResolvedPlace lists the place's fields", () => {
	const { container } = renderComponent(<ResolvedPlace place={PLACE} />)

	expect(container.textContent).toContain("New York")
	expect(container.textContent).toContain("locality")
	expect(container.textContent).toContain("85977539")
	expect(container.textContent).toContain("40.7128")
})
