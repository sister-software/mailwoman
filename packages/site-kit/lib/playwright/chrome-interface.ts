/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Playwright assertions on the geometry and reachability of the floating chrome shared by the map apps.
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
 * The bearing in degrees that the compass check rotates the map to.
 *
 * Any bearing outside the compass's dead zone works.
 */
const BEARING_OFF_NORTH = 42

/**
 * The number of pointer moves in the scoped-query check.
 *
 * The hover hook throttles to one query per frame, so the check needs several moves to see several queries.
 */
const POINTER_MOVES = 8

/**
 * Selectors for the chrome pieces that float over a map.
 *
 * The checks skip a missing piece, because not every app mounts every piece on every route.
 */
export const CHROME_SELECTORS = [
	".mw-map-panel",
	".search-slot",
	".mw-map-control-stack",
	".mw-map-sheet--side",
	".feature-panel",
	".mw-map-footer",
] as const

/**
 * Returns whether two boxes share any area.
 *
 * The `tolerance` in pixels lets touching edges pass despite the browser's sub-pixel rounding.
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
 * Asserts that no two floating chrome pieces overlap.
 *
 * The side sheet is exempt because on a phone it covers the other chrome by design.
 */
export async function expectNoChromeOverlap(page: Page): Promise<void> {
	const boxes = [...(await visibleBoxes(page))].filter(([selector]) => selector !== ".mw-map-sheet--side")
	const collisions: string[] = []

	for (let i = 0; i < boxes.length; i++) {
		for (let j = i + 1; j < boxes.length; j++) {
			const [leftSelector, left] = boxes[i]!
			const [rightSelector, right] = boxes[j]!

			// The panel and the search slot contain other chrome, so their pairs are skipped.
			if (leftSelector === ".mw-map-panel" || leftSelector === ".search-slot") continue

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
 * Asserts that the map panel and the feature panel end above the footer strip's top edge.
 */
export async function expectNothingUnderTheFooter(page: Page): Promise<void> {
	const footer = await page.locator(".mw-map-footer").boundingBox()

	if (!footer) return

	for (const selector of [".mw-map-panel", ".feature-panel"]) {
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
 * Asserts that `opener` opens one side sheet, and that both the sheet's close button and `opener` close it.
 *
 * On a phone the sheet covers its opener, so the sheet needs its own close button.
 * On a wide screen the opener stays visible, so it must also toggle the sheet closed.
 */
export async function expectSheetOpensAndCloses(page: Page, opener: Locator): Promise<void> {
	const sheet = page.locator(".mw-map-sheet--side")

	await opener.click()
	await expect(sheet).toBeVisible()
	await expect(sheet, "one side sheet at a time").toHaveCount(1)
	await expect(sheet.locator(".mw-map-sheet__close"), "the sheet carries its own close").toHaveCount(1)

	await sheet.locator(".mw-map-sheet__close").click()
	await expect(sheet).toHaveCount(0)

	await opener.click()
	await expect(sheet).toBeVisible()
	await opener.click()
	await expect(sheet).toHaveCount(0)
}

/**
 * Runs {@link expectSheetOpensAndCloses} on every control in the map's control stack that opens a sheet.
 *
 * The controls are discovered from the page, so a newly added control is checked automatically.
 * A control that opens no sheet, such as a zoom button, is skipped.
 *
 * @returns The accessible names of the controls that were checked.
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
			// The second click restores the control's original state.
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
 * Asserts that a hit test at the element's centre reaches the element.
 *
 * Playwright's `toBeVisible` passes for an element that an ancestor's `overflow` clips away.
 * A hit test fails for that element because a clipped element receives no hits.
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
 * Asserts that every `queryRenderedFeatures` call made during pointer moves passes a `layers` list.
 *
 * An unscoped call walks every layer in the style and can use a whole frame per pointer move.
 * The check inspects the call arguments because a timing assertion would be flaky.
 *
 * @param handle The global under which the app publishes its map instance.
 */
export async function expectPointerQueriesStayScoped(page: Page, handle: string): Promise<void> {
	await page.evaluate((name) => {
		const map = Reflect.get(globalThis, name) as
			| { queryRenderedFeatures(point: unknown, options?: { layers?: string[] }): unknown[] }
			| undefined

		if (!map) return

		const calls: boolean[] = []

		Reflect.set(globalThis, "__mailwomanQueryScopes", calls)

		const original = map.queryRenderedFeatures.bind(map)

		map.queryRenderedFeatures = (point: unknown, options?: { layers?: string[] }) => {
			calls.push(Array.isArray(options?.layers))

			return original(point, options)
		}
	}, handle)

	const canvas = page.locator(".maplibregl-canvas")
	const box = await canvas.boundingBox()

	if (!box) return

	for (let step = 0; step < POINTER_MOVES; step++) {
		await page.mouse.move(box.x + box.width / 2 + step * 7, box.y + box.height / 2 + step * 5)
	}

	// The hover query runs on an animation frame, so the check waits for one.
	await page.waitForTimeout(300)

	const scopes = await page.evaluate(() => (Reflect.get(globalThis, "__mailwomanQueryScopes") as boolean[]) ?? [])

	expect(scopes.length, "the pointer ran at least one rendered-feature query").toBeGreaterThan(0)

	expect(
		scopes.filter((scoped) => !scoped).length,
		`${scopes.filter((scoped) => !scoped).length} of ${scopes.length} pointer queries walked every layer in the style`
	).toBe(0)
}

/**
 * Asserts that the compass appears when the map is rotated off north and that clicking it hides it.
 *
 * The check calls `setBearing` directly because the rotate gesture belongs to MapLibre.
 */
export async function expectCompassFollowsBearing(page: Page, handle: string): Promise<void> {
	const compass = page.locator(".mw-map-compass")

	await expect(compass, "a compass is mounted").toHaveCount(1)
	await expect(compass).toBeHidden()

	// The callback is serialized into the browser, so every value it uses must be passed as an argument.
	await page.evaluate(
		({ name, degrees }) => {
			// `Reflect.get` reads the global because `globalThis` has no index signature.
			const published = Reflect.get(globalThis, name) as { setBearing(value: number): void } | undefined

			published?.setBearing(degrees)
		},
		{ name: handle, degrees: BEARING_OFF_NORTH }
	)

	await expect(compass).toBeVisible()

	await compass.click()
	await expect(compass).toBeHidden()
}
