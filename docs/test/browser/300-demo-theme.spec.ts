import { test } from "#e2e"

test.describe("Demo — theme toggling", () => {
	test("light → dark → light keeps the map alive (no style-race errors)", async ({ demo }) => {
		await demo.goto()
		await demo.setTheme("dark")
		await demo.setTheme("light")
		demo.console.assertNoFailEvents()
	})

	test("theme toggle after a successful resolve preserves the marker", async ({ demo }) => {
		await demo.goto("Chicago, IL")
		await demo.submit()
		await demo.expectMarkerVisible()

		await demo.setTheme("dark")
		await demo.expectMarkerVisible()

		demo.console.assertNoFailEvents()
	})
})
