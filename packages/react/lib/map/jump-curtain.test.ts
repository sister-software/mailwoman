// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { createJumpCurtain, type CurtainMap, curtainColor } from "@mailwoman/react/map/jump-curtain"
import { afterEach, describe, expect, test } from "vitest"

/**
 * A map container with a canvas container and a control container after it, as MapLibre builds them.
 */
function stubMap(backgroundPaint: unknown, containerBackground = ""): CurtainMap & { container: HTMLElement } {
	const container = document.createElement("div")
	const canvasContainer = document.createElement("div")
	const controls = document.createElement("div")

	container.style.background = containerBackground
	container.append(canvasContainer, controls)
	document.body.append(container)

	return {
		container,
		getContainer: () => container,
		getCanvasContainer: () => canvasContainer,
		getStyle: () => ({ layers: [{ id: "bg", type: "background" }] }),
		getPaintProperty: () => backgroundPaint,
	}
}

afterEach(() => {
	document.body.replaceChildren()
})

describe("curtainColor", () => {
	test("takes the style's background color", () => {
		expect(curtainColor(stubMap("#0b1020"))).toBe("#0b1020")
	})

	test("falls back to the container's computed background when the paint is an expression", () => {
		expect(curtainColor(stubMap(["interpolate", ["linear"], ["zoom"], 0, "#000", 10, "#fff"], "rgb(1, 2, 3)"))).toBe(
			"rgb(1, 2, 3)"
		)
	})
})

describe("createJumpCurtain", () => {
	test("covers the canvas below the controls without taking pointer events, then removes itself", () => {
		const map = stubMap("#0b1020")
		const curtain = createJumpCurtain(map)

		curtain.cover()

		const overlay = map.container.querySelector<HTMLElement>("[data-mw-jump-curtain]")

		expect(overlay).not.toBeNull()
		expect(overlay!.previousElementSibling).toBe(map.getCanvasContainer())
		expect(getComputedStyle(overlay!).pointerEvents).toBe("none")
		expect(getComputedStyle(overlay!).backgroundColor).toBe("rgb(11, 16, 32)")

		curtain.reveal()
		curtain.remove()

		expect(map.container.querySelector("[data-mw-jump-curtain]")).toBeNull()
	})
})
