// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { ResolvedPlace } from "@mailwoman/react/pipeline/ResolvedPlace"
import { expect, test } from "vitest"

import { renderComponent } from "../../render.tsx"

const PLACE = { id: 85_977_539, name: "New York", placetype: "locality", lat: 40.7128, lon: -74.006, score: 0.82 }

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
