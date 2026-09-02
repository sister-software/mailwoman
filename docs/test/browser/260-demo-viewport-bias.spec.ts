/**
 * @file Viewport-bias wiring (#938 demo consumer). The map's current center is fed to `resolveTree` as a SOFT proximity
 *   hint, so an in-view namesake sorts ahead of a distant one at equal exact-tier. Two assertions pin the contract: (1)
 *   with the map parked over Ohio, "Dublin" resolves to Dublin, OH — the bias broke the tie the user's view implies;
 *   (2) a strong population signal still wins regardless of view — "Paris" stays in France even from a US-centered map
 *   (guards the #912 fix, which the bias must never undo). Bias is conditioned on zoom ≥ 4, so a whole-globe view
 *   contributes nothing.
 */

import { expect, test } from "#e2e"

test.describe("Demo — viewport bias (#938)", () => {
	test("map over Ohio biases 'Dublin' to Dublin, OH", async ({ demo, page }) => {
		await demo.goto()

		// Park the map on Ohio, zoomed in past the global-view threshold.
		await page.evaluate(() => {
			const w = globalThis as { __mailwomanDemoMap?: { jumpTo: (o: unknown) => void } }
			w.__mailwomanDemoMap?.jumpTo({ center: [-83.11, 40.1], zoom: 8 })
		})

		// The map loads independently of the classifier — wait until the jump has actually taken (zoom
		// past the global-view gate) so the viewport bias is live before we submit.
		await page.waitForFunction(
			() => {
				const m = (globalThis as { __mailwomanDemoMap?: { getZoom: () => number } }).__mailwomanDemoMap

				return !!m && m.getZoom() >= 7
			},
			{ timeout: 15_000 }
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
			const w = globalThis as { __mailwomanDemoMap?: { jumpTo: (o: unknown) => void } }
			w.__mailwomanDemoMap?.jumpTo({ center: [-83, 42.3], zoom: 8 }) // Michigan
		})

		await page.waitForTimeout(500)
		await demo.setAddress("Paris")
		await demo.submit()

		demo.expectNear(await demo.readCoords(), { lat: 48.8, lon: 2.35 }, 0.35)
		demo.console.assertNoFailEvents()
	})
})
