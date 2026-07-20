/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { expect, test } from "vitest"

import { renderComponent } from "../test/render.tsx"
import { ComponentTable } from "./ComponentTable.tsx"

test("ComponentTable renders a row per node with a tiered confidence bar", () => {
	const { container } = renderComponent(
		<ComponentTable
			nodes={[
				{ tag: "house_number", value: "350", confidence: 0.97 },
				{ tag: "street", value: "5th Ave", confidence: 0.42 },
				{ tag: "locality", value: "New York" },
			]}
		/>
	)

	const rows = container.querySelectorAll("tbody tr")
	expect(rows).toHaveLength(3)
	expect(rows[0]?.textContent).toContain("house_number")
	expect(rows[0]?.textContent).toContain("350")

	// High confidence → green tier; low → red tier; missing → dash.
	expect(container.querySelector(".mw-conf__bar--high")).toBeTruthy()
	expect(container.querySelector(".mw-conf__bar--low")).toBeTruthy()
	expect(container.querySelector(".mw-conf__dash")).toBeTruthy()
})
