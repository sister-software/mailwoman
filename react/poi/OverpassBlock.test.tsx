/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { expect, test } from "vitest"

import { renderComponent } from "../test/render.tsx"
import { OverpassBlock } from "./OverpassBlock.tsx"

const QL = "[out:json];\nnode[amenity=drinking_water];\nout;"

test("OverpassBlock renders the query in a code block with a copy button", () => {
	const { container } = renderComponent(<OverpassBlock overpassQL={QL} />)

	expect(container.querySelector(".mw-overpass__code")?.textContent).toContain("drinking_water")
	expect(container.querySelector("button")?.textContent).toContain("Copy")
})

test("OverpassBlock renders the emitter error when the export failed", () => {
	const { container } = renderComponent(<OverpassBlock overpassError="no osmTag for category" />)

	expect(container.querySelector(".mw-error")?.textContent).toContain("no osmTag")
	expect(container.querySelector(".mw-overpass__code")).toBeNull()
})

test("OverpassBlock renders nothing when neither prop is set", () => {
	const { container } = renderComponent(<OverpassBlock />)

	expect(container.textContent).toBe("")
})
