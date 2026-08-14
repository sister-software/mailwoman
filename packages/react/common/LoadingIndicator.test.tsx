/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { expect, test } from "vitest"

import { renderComponent } from "../test/render.tsx"
import { LoadingIndicator } from "./LoadingIndicator.tsx"

test("staged mode tiers steps into complete / active / pending", () => {
	const { container } = renderComponent(
		<LoadingIndicator mode="staged" steps={["shape", "classify", "resolve"]} activeStep={1} />
	)

	expect(container.querySelectorAll(".mw-staged__step")).toHaveLength(3)
	expect(container.querySelector(".mw-staged__step--complete")?.textContent).toContain("shape")
	expect(container.querySelector(".mw-staged__step--active")?.textContent).toContain("classify")
	expect(container.querySelector(".mw-staged__step--pending")?.textContent).toContain("resolve")
})

test("spinner mode renders a ring with the requested size modifier", () => {
	const { container } = renderComponent(<LoadingIndicator mode="spinner" size="small" />)

	expect(container.querySelector(".mw-spinner.mw-spinner--small")).toBeTruthy()
})
