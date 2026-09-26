/**
 * @file Viewport-bias wiring: the map's current center feeds `resolveTree` as a soft proximity hint, so an in-view namesake sorts ahead of a distant one at equal exact tier, and a strong population signal still wins regardless of view; the bias is conditioned on zoom ≥ 4, so a whole-globe view contributes no bias.
 */

import { expect, test } from "../e2e/index.ts"

test.describe("Demo — viewport bias (#938)", () => {
	test("map over Ohio biases 'Dublin' to Dublin, OH", async ({ demo, page }) => {
		await demo.goto()

		await page.evaluate(() => {
			const w = globalThis as { __mailwomanMapCanvas?: { jumpTo: (o: unknown) => void } }
			w.__mailwomanMapCanvas?.jumpTo({ center: [-83.11, 40.1], zoom: 8 })
		})

		// The map loads independently of the classifier, so wait until the jump has taken
		// (zoom past the global-view threshold) before submitting.
		await page.waitForFunction(
			() => {
				const m = (globalThis as { __mailwomanMapCanvas?: { getZoom: () => number } }).__mailwomanMapCanvas

				return !!m && m.getZoom() >= 7
			},
			undefined,
			{ timeout: 15_000, polling: 500 }
		)

		await demo.setAddress("Dublin")
		await demo.submit()

		const { markerCount } = await demo.readResult()
		demo.expectNear(await demo.readCoords(), { lat: 40.05, lon: -83.1 }, 0.55)
		expect(markerCount).toBeGreaterThan(0)
		demo.console.assertNoFailEvents()
	})

	test("population still wins: 'Paris' stays in France even from a US-centered map", async ({ demo, page }) => {
		await demo.goto()

		await page.evaluate(() => {
			const w = globalThis as { __mailwomanMapCanvas?: { jumpTo: (o: unknown) => void } }
			w.__mailwomanMapCanvas?.jumpTo({ center: [-83, 42.3], zoom: 8 }) // Michigan
		})

		await page.waitForTimeout(500)
		await demo.setAddress("Paris")
		await demo.submit()

		demo.expectNear(await demo.readCoords(), { lat: 48.8, lon: 2.35 }, 0.35)
		demo.console.assertNoFailEvents()
	})
})
