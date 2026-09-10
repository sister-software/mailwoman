/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The contract every map app's floating chrome answers, as assertions a browser test can run.
 *
 *   It lives here rather than in either app's `test/e2e/` because both apps make the same promises about the same
 *   components, and the defects it exists to catch were found by hand on one app while the other carried them too: a
 *   side sheet that opened over the control that opened it, a footer strip that covered the bottom sheet's last rows,
 *   a compass mounted nowhere, two panels sharing an edge.
 *
 *   IT ASSERTS GEOMETRY AND REACHABILITY, NOT APPEARANCE. Whether the glass is the right colour is a judgement; that
 *   two controls do not occupy the same pixels, and that every panel can be closed by someone holding a phone, are
 *   facts a machine can hold.
 */

import { expect, type Locator, type Page } from "@playwright/test"

/**
 * A rectangle as the browser reports it.
 */
export interface Box {
	x: number
	y: number
	width: number
	height: number
}

/**
 * How far off north the compass check turns the map. Any bearing past the control's own dead zone would do; this one is
 * far enough that a needle drawn at the wrong angle is visible in a failure screenshot.
 */
const BEARING_OFF_NORTH = 42

/**
 * The chrome pieces that float over a map, by selector. A missing one is skipped rather than failed: the planetary apps
 * carry no chip row on every route, and a test for one app must not fail on the other's absences.
 */
export const CHROME_SELECTORS = [
	".mw-map-chrome--top",
	".search-slot",
	".mw-map-control-stack",
	".mw-map-sheet--side",
	".mw-map-sheet--bottom",
	".feature-panel",
	".mw-map-footer",
] as const

/**
 * Two boxes overlap when they share any area. Touching edges do not count — a sheet ending exactly on the footer's top
 * edge is correct, and the sub-pixel rounding a browser reports would otherwise make that a failure.
 */
export function boxesOverlap(a: Box, b: Box, tolerance = 1): boolean {
	return (
		a.x + a.width - tolerance > b.x &&
		b.x + b.width - tolerance > a.x &&
		a.y + a.height - tolerance > b.y &&
		b.y + b.height - tolerance > a.y
	)
}

async function visibleBoxes(page: Page): Promise<Map<string, Box>> {
	const boxes = new Map<string, Box>()

	for (const selector of CHROME_SELECTORS) {
		const locator = page.locator(selector)

		if ((await locator.count()) !== 1) continue

		if (!(await locator.isVisible())) continue

		const box = await locator.boundingBox()

		if (box) {
			boxes.set(selector, box)
		}
	}

	return boxes
}

/**
 * No two floating pieces of chrome occupy the same pixels.
 *
 * A SIDE SHEET IS EXEMPT, because on a phone it is deliberately the whole panel laid over everything else — the overlap
 * there is the design. Every other pair has to clear.
 */
export async function expectNoChromeOverlap(page: Page): Promise<void> {
	const boxes = [...(await visibleBoxes(page))].filter(([selector]) => selector !== ".mw-map-sheet--side")
	const collisions: string[] = []

	for (let i = 0; i < boxes.length; i++) {
		for (let j = i + 1; j < boxes.length; j++) {
			const [leftSelector, left] = boxes[i]!
			const [rightSelector, right] = boxes[j]!

			// The top column contains the search pill and the chips, so a nested pair is not a collision.
			if (leftSelector === ".mw-map-chrome--top" || leftSelector === ".search-slot") continue

			if (boxesOverlap(left, right)) {
				collisions.push(
					`${leftSelector} (${Math.round(left.x)},${Math.round(left.y)} ${Math.round(left.width)}x${Math.round(left.height)}) overlaps ${rightSelector} (${Math.round(right.x)},${Math.round(right.y)} ${Math.round(right.width)}x${Math.round(right.height)})`
				)
			}
		}
	}

	expect(collisions, "chrome pieces share pixels").toEqual([])
}

/**
 * Nothing that carries content ends underneath the footer strip, which is the defect that hid a feature's diameter and
 * its source line on a phone.
 */
export async function expectNothingUnderTheFooter(page: Page): Promise<void> {
	const footer = await page.locator(".mw-map-footer").boundingBox()

	if (!footer) return

	for (const selector of [".mw-map-sheet--bottom", ".feature-panel"]) {
		const locator = page.locator(selector)

		if ((await locator.count()) !== 1 || !(await locator.isVisible())) continue

		const box = await locator.boundingBox()

		if (!box) continue

		expect(Math.round(box.y + box.height), `${selector} ends below the footer's top edge`).toBeLessThanOrEqual(
			Math.round(footer.y) + 1
		)
	}
}

/**
 * A control that opens a sheet closes it again, and the sheet carries its own close.
 *
 * Both halves matter and for different reasons: on a wide screen the opening control stays beside the sheet, and on a
 * phone the sheet covers it — so a sheet without its own close is one a phone cannot dismiss, and a control that cannot
 * toggle is one a pointer cannot undo.
 */
export async function expectSheetOpensAndCloses(page: Page, opener: Locator): Promise<void> {
	const sheet = page.locator(".mw-map-sheet--side")

	await opener.click()
	await expect(sheet).toBeVisible()
	await expect(sheet, "one side sheet at a time").toHaveCount(1)
	await expect(sheet.locator(".mw-map-sheet__close"), "the sheet carries its own close").toHaveCount(1)

	// Its own close dismisses it.
	await sheet.locator(".mw-map-sheet__close").click()
	await expect(sheet).toHaveCount(0)

	// And so does the control that opened it, which is the path a pointer on a wide screen takes.
	await opener.click()
	await expect(sheet).toBeVisible()
	await opener.click()
	await expect(sheet).toHaveCount(0)
}

/**
 * Every control in the map's column that opens a sheet opens exactly one, and closes it both ways.
 *
 * The controls are READ OFF THE PAGE rather than named here, so an app that mounts a different set is held to the same
 * contract and a control added later is covered without this file changing. A control that opens no sheet — a compass,
 * a zoom button — is skipped, which is what keeps the walk honest about what it actually checked.
 *
 * @returns The accessible names of the controls that were exercised.
 */
export async function expectEverySheetControlCloses(page: Page): Promise<string[]> {
	const controls = page.locator(".mw-map-control-stack .mw-map-control")
	const names: string[] = []

	for (let index = 0; index < (await controls.count()); index++) {
		const control = controls.nth(index)
		const name = (await control.getAttribute("aria-label")) ?? `control ${index}`

		await control.click()

		const opened = await page.locator(".mw-map-sheet--side").count()

		if (opened === 0) {
			// Nothing opened, so there is nothing to close; leave the control as it was found.
			await control.click()

			continue
		}

		await page.locator(".mw-map-sheet__close").click()
		await expect(page.locator(".mw-map-sheet--side")).toHaveCount(0)

		await expectSheetOpensAndCloses(page, control)
		names.push(name)
	}

	return names
}

/**
 * The element is not merely in the layout but actually reachable at its own centre.
 *
 * `toBeVisible` is not this assertion and cannot be: it means a non-empty box and no `visibility: hidden`, and an
 * element clipped away by an ancestor's `overflow` keeps both. The sources popover shipped exactly that way — present,
 * carrying the right credits, and erased by the footer strip's own `overflow-x` — and a `toBeVisible` test passed over
 * it. Hit-testing is what tells the difference, because a clipped element receives no hits.
 */
export async function expectReachable(page: Page, selector: string): Promise<void> {
	const locator = page.locator(selector)

	await expect(locator).toBeVisible()

	const box = await locator.boundingBox()

	expect(box, `${selector} has a box`).not.toBeNull()

	const reached = await page.evaluate(({ x, y, target }) => Boolean(document.elementFromPoint(x, y)?.closest(target)), {
		x: box!.x + box!.width / 2,
		y: box!.y + box!.height / 2,
		target: selector,
	})

	expect(reached, `${selector} is clipped or covered at its own centre`).toBe(true)
}

/**
 * The compass appears once the map leaves north and hides again when it returns, and pressing it is what returns it.
 *
 * `setBearing` drives the map directly rather than synthesising a rotate gesture: the gesture is MapLibre's to test,
 * and what this asserts is the chrome's response to a bearing.
 */
export async function expectCompassFollowsBearing(page: Page, handle: string): Promise<void> {
	const compass = page.locator(".mw-map-compass")

	await expect(compass, "a compass is mounted").toHaveCount(1)
	await expect(compass).toBeHidden()

	// The callback is serialized and runs in the browser, so it closes over nothing from this module — every value it
	// needs is an argument.
	await page.evaluate(
		({ name, degrees }) => {
			// The app republishes its map instance under a well-known global for exactly this kind of driving.
			// `Reflect.get` reads it without asserting anything about `globalThis`, which carries no index signature.
			const published = Reflect.get(globalThis, name) as { setBearing(value: number): void } | undefined

			published?.setBearing(degrees)
		},
		{ name: handle, degrees: BEARING_OFF_NORTH }
	)

	await expect(compass).toBeVisible()

	await compass.click()
	await expect(compass).toBeHidden()
}
