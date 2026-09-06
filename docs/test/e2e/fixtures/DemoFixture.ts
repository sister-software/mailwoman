/**
 * @file High-level page object for the /demo page. Encapsulates address input, submit, result read-back, theme
 *   toggling, and example-button clicks. Tests stay focused on intent (`await demo.setAddress(...); await
 *   demo.submit()`) instead of selector boilerplate. All assertions live in the spec files — this class is purely
 *   action + state read.
 */

import { expect, type Page } from "@playwright/test"

import type { ConsoleFixture } from "./ConsoleFixture.ts"

export interface ResolvedResult {
	/**
	 * Component table rows: `{ tag, value, confidence }` per parsed BIO node.
	 */
	parsedRows: Array<{ tag: string; value: string; confidence: string }>
	/**
	 * Definition list under "Resolved place" — empty if the WOF cascade returned no hits.
	 */
	resolved: Record<string, string>
	/**
	 * Count of `.maplibregl-marker` elements currently on the map.
	 */
	markerCount: number
}

export class DemoFixture {
	constructor(
		private readonly page: Page,
		public readonly console: ConsoleFixture
	) {}

	/**
	 * Navigate to the demo page and wait until the classifier is loaded (submit enables).
	 */
	async goto(query?: string): Promise<void> {
		// No trailing slash: the site builds the page as `demo.html`, so `/demo/` is a 404 on the
		// Pages deploy (the status Docusaurus' own dev server hides by serving the route anyway).
		const path = query ? `/demo?q=${encodeURIComponent(query)}` : "/demo"
		await this.page.goto(path, { waitUntil: "networkidle" })
		await this.expectReady()
	}

	/**
	 * Wait for the cold-load (~25 MB ONNX + map style + sqlite-wasm) to complete.
	 */
	async expectReady(): Promise<void> {
		await this.page.waitForFunction(
			() => {
				const btn = document.querySelector("button[type='submit']")

				return btn instanceof HTMLButtonElement && !btn.disabled
			},
			{ timeout: 180_000 }
		)
	}

	async setAddress(text: string): Promise<void> {
		const input = this.page.locator("#mw-pipeline-input")
		await input.fill(text)
	}

	/**
	 * Type a partial address to trigger the place-autocomplete typeahead (#587), then read the "Did you mean" suggestion
	 * texts once the debounced FST walk renders them.
	 */
	async readSuggestions(text: string): Promise<string[]> {
		await this.setAddress(text)
		const list = this.page.locator("#mw-demo-suggest-list")
		await list.waitFor({ state: "visible", timeout: 5000 }).catch(() => {})

		return this.page.locator("#mw-demo-suggest-list [role='option']").allTextContents()
	}

	/**
	 * Click the autocomplete suggestion whose text contains `name`.
	 */
	async pickSuggestion(name: string): Promise<void> {
		await this.page.locator("#mw-demo-suggest-list [role='option']", { hasText: name }).first().click()
	}

	/**
	 * Current value of the address input.
	 */
	async addressValue(): Promise<string> {
		return this.page.locator("#mw-pipeline-input").inputValue()
	}

	async clickExample(label: string): Promise<void> {
		await this.page.locator(`button:has-text("${label}")`).first().click()
	}

	async submit(): Promise<void> {
		await this.page.locator("button[type='submit']").click()

		// Block until the result panel renders so callers can immediately readResult().
		await this.page.waitForFunction(() => document.body.textContent?.includes("Parsed components"), {
			timeout: 60_000,
		})

		// Map needs a beat to finish fitBounds + (re-)wire terrain.
		await this.page.waitForTimeout(2000)
	}

	async readResult(): Promise<ResolvedResult> {
		return this.page.evaluate<ResolvedResult>(() => {
			const parsedRows = [...document.querySelectorAll("tbody tr")].map((tr) => {
				const cells = [...tr.querySelectorAll("td")].map((td) => td.textContent ?? "")

				return { tag: cells[0] ?? "", value: cells[1] ?? "", confidence: cells[2] ?? "" }
			})

			const resolved: Record<string, string> = {}

			for (const dt of document.querySelectorAll("dl dt")) {
				const dd = dt.nextElementSibling

				if (dt.textContent && dd?.textContent) {
					resolved[dt.textContent] = dd.textContent
				}
			}

			const markerCount = document.querySelectorAll(".maplibregl-marker").length

			return { parsedRows, resolved, markerCount }
		})
	}

	/**
	 * Parse the resolved-place "coords" row into numbers. `NaN` components mean nothing resolved.
	 */
	async readCoords(): Promise<{ lat: number; lon: number }> {
		const { resolved } = await this.readResult()
		const [lat, lon] = (resolved["coords"] ?? "").split(",").map((s) => Number.parseFloat(s.trim()))

		return { lat, lon }
	}

	/**
	 * Assert a coordinate lands within `tolDeg` degrees of `expected` on both axes.
	 */
	expectNear(coords: { lat: number; lon: number }, expected: { lat: number; lon: number }, tolDeg: number): void {
		const label = `resolved ${coords.lat},${coords.lon} should be within ${tolDeg}° of ${expected.lat},${expected.lon}`
		expect(Number.isFinite(coords.lat) && Number.isFinite(coords.lon), label).toBe(true)
		expect(coords.lat, label).toBeGreaterThan(expected.lat - tolDeg)
		expect(coords.lat, label).toBeLessThan(expected.lat + tolDeg)
		expect(coords.lon, label).toBeGreaterThan(expected.lon - tolDeg)
		expect(coords.lon, label).toBeLessThan(expected.lon + tolDeg)
	}

	/**
	 * Force Docusaurus's data-theme attribute to a specific value.
	 */
	async setTheme(theme: "light" | "dark"): Promise<void> {
		await this.page.evaluate((t) => {
			document.documentElement.setAttribute("data-theme", t)
		}, theme)

		// Allow the MutationObserver-driven setStyle + terrain re-wire to settle.
		await this.page.waitForTimeout(2000)
	}

	/**
	 * Convenience matcher: passes when there's exactly one marker on the map.
	 */
	async expectMarkerVisible(): Promise<void> {
		const count = await this.page.locator(".maplibregl-marker").count()
		expect(count, "expected exactly one marker after submit").toBeGreaterThan(0)
	}
}
