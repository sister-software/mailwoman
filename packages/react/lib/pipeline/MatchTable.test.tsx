// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { MatchTable } from "@mailwoman/react/pipeline/MatchTable"
import { expect, test } from "vitest"

import { renderComponent } from "../../test/render.tsx"

test("MatchTable states a matched place and an unmatched span with what was searched", () => {
	const { container } = renderComponent(
		<MatchTable
			matches={[
				{
					tag: "locality",
					value: "Brislington",
					matched: true,
					name: "Brislington",
					placetype: "borough",
					placeID: "wof:85786019",
					note: null,
				},
				{
					tag: "street",
					value: "Bristol Hill",
					matched: false,
					name: null,
					placetype: null,
					placeID: null,
					note: "no street data for this region",
				},
			]}
		/>
	)

	const rows = container.querySelectorAll("tbody tr")

	expect(rows).toHaveLength(2)
	expect(rows[0]?.textContent).toContain("Brislington (borough) wof:85786019")
	expect(rows[1]?.textContent).toContain("no match: no street data for this region")
})
