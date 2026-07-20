/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { expect, test } from "vitest"

import { renderComponent } from "../test/render.tsx"
import { SubjectPanel } from "./SubjectPanel.tsx"
import type { CategoryRecord, POISubject } from "./types.ts"

function subject(overrides: Partial<POISubject> = {}): POISubject {
	return {
		category: { id: "hospital", label: "Hospital" } as unknown as CategoryRecord,
		matchedPhrase: "hospital",
		confidence: 0.84,
		remainder: "New York",
		buildLocal: false,
		...overrides,
	}
}

test("SubjectPanel renders the category, matched phrase, confidence, and anchor", () => {
	const { container } = renderComponent(<SubjectPanel subject={subject()} />)

	expect(container.querySelector(".mw-subject__chip")?.textContent).toBe("Hospital")
	expect(container.textContent).toContain("hospital")
	expect(container.textContent).toContain("84%")
	expect(container.textContent).toContain("New York")
	expect(container.querySelector(".mw-subject__badge")).toBeNull()
})

test("SubjectPanel shows the build-local badge + note when required", () => {
	const { container } = renderComponent(<SubjectPanel subject={subject({ buildLocal: true })} />)

	expect(container.querySelector(".mw-subject__badge")?.textContent).toContain("build-local")
	expect(container.querySelector(".mw-subject__note")).toBeTruthy()
})

test("SubjectPanel marks a missing anchor as a global query", () => {
	const { container } = renderComponent(<SubjectPanel subject={subject({ remainder: "" })} />)

	expect(container.textContent).toContain("global query")
})
