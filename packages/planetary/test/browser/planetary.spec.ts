/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The smoke over a built body: the preview serves whichever body it was built for, and the spec reads it from
 *   `build.json` rather than assuming one. It reaches the real archives on `tiles.mailwoman.ai` and the search
 *   artifact on `public.mailwoman.ai`, so it needs the network, as the Earth production smoke does.
 */

import { expect, test } from "@playwright/test"

const KNOWN = {
	moon: { query: "tycho", name: "Tycho" },
	mars: { query: "olympus", name: "Olympus Mons" },
} as const

test("the globe loads for the built body, search finds a known feature, selection sets the URL and survives reload", async ({
	page,
	request,
}) => {
	const info = (await (await request.get("/build.json")).json()) as { app: string }
	const body = info.app.replace("mailwoman-", "") as keyof typeof KNOWN
	const known = KNOWN[body]

	expect(known, `build.json names ${info.app}`).toBeDefined()

	await page.goto("/")
	await expect(page.locator("canvas.maplibregl-canvas")).toBeVisible()
	await expect(page.locator("main[data-search='ready']")).toBeVisible({ timeout: 60_000 })

	await page.getByRole("combobox").fill(known.query)

	await page
		.getByRole("option", { name: new RegExp(known.name, "u") })
		.first()
		.click()

	await expect(page).toHaveURL(/\/feature\/\d+$/u)
	await expect(page.getByRole("article")).toContainText(known.name)

	await page.reload()
	await expect(page.getByRole("article")).toContainText(known.name, { timeout: 60_000 })
})

test("an unknown path is the not-found view, not the globe", async ({ page }) => {
	await page.goto("/nowhere")
	await expect(page.getByTestId("not-found")).toBeVisible()
})
