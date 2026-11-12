// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   A full-map overlay that hides the instant change of view when a long camera move jumps across the globe.
 *
 *   The overlay fades in over the map, the camera jumps under it, and it fades
 *   out as the camera animates in.
 *   It takes the colour of the style's background layer.
 *
 *   A dark style therefore fades through its own dark background rather than through white.
 *
 *   The overlay never takes pointer events, and it is removed after its fade-out.
 */

/**
 * The length, in milliseconds, of each half of the fade: in over the old view, then out over the new one.
 */
export const JUMP_FADE_MS = 75

/**
 * The steps of one jump's fade.
 */
export interface JumpCurtain {
	/**
	 * Fades the overlay in over {@linkcode JUMP_FADE_MS}.
	 */
	cover(): void
	/**
	 * Fades the overlay out over {@linkcode JUMP_FADE_MS}.
	 */
	reveal(): void
	/**
	 * Removes the overlay at once, whatever step it's at.
	 */
	remove(): void
}

/**
 * The map methods the overlay reads, a subset of MapLibre's `Map`.
 */
export interface CurtainMap {
	getContainer(): HTMLElement
	getCanvasContainer(): HTMLElement
	getStyle(): { layers?: ReadonlyArray<{ id: string; type: string }> } | undefined
	getPaintProperty(layerID: string, name: string): unknown
}

/**
 * The colour the overlay fades through.
 *
 * It is the style's first background layer's colour when that colour is a literal.
 * Otherwise it is the map container's computed background.
 * The page's theme sets that background.
 */
export function curtainColor(map: CurtainMap): string {
	const background = map.getStyle()?.layers?.find((layer) => layer.type === "background")
	const paint = background ? map.getPaintProperty(background.id, "background-color") : null

	if (typeof paint === "string" && paint) return paint

	return getComputedStyle(map.getContainer()).backgroundColor
}

/**
 * Creates the overlay for one jump on `map`.
 *
 * The overlay sits directly above the canvas, so the map's controls stay drawn over it.
 */
export function createJumpCurtain(map: CurtainMap): JumpCurtain {
	let overlay: HTMLDivElement | null = null

	const fade = (from: number, to: number) => {
		overlay?.animate([{ opacity: from }, { opacity: to }], {
			duration: JUMP_FADE_MS,
			easing: "linear",
			fill: "forwards",
		})
	}

	return {
		cover() {
			overlay ??= document.createElement("div")
			overlay.dataset["mwJumpCurtain"] = ""

			Object.assign(overlay.style, {
				position: "absolute",
				inset: "0",
				pointerEvents: "none",
				opacity: "0",
				background: curtainColor(map),
			})

			map.getCanvasContainer().after(overlay)
			fade(0, 1)
		},
		reveal() {
			fade(1, 0)
		},
		remove() {
			overlay?.remove()
			overlay = null
		},
	}
}
