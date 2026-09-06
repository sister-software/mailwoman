/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { PresetChips } from "@mailwoman/react/common/PresetChips"
import { expect, test } from "vitest"
import { userEvent } from "vitest/browser"

import { renderComponent } from "../../render.tsx"

test("PresetChips renders one chip per preset and calls onPick with its value", async () => {
	let picked = ""

	const { container } = renderComponent(
		<PresetChips
			presets={[
				{ label: "Alpha", value: "alpha-value" },
				{ label: "Beta", value: "beta-value" },
			]}
			onPick={(value) => {
				picked = value
			}}
		/>
	)

	const chips = container.querySelectorAll(".mw-chip")
	expect(chips).toHaveLength(2)

	await userEvent.click(chips[1] as HTMLElement)
	expect(picked).toBe("beta-value")
})

test("PresetChips disables chips when disabled", () => {
	const { container } = renderComponent(
		<PresetChips presets={[{ label: "Alpha", value: "a" }]} onPick={() => {}} disabled />
	)

	expect((container.querySelector(".mw-chip") as HTMLButtonElement).disabled).toBe(true)
})
