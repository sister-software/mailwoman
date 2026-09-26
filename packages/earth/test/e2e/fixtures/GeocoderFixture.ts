/**
 * @file High-level page object for the geocoder page, encapsulating address input, submit, result read-back, theme
 * toggling, and example-button clicks; assertions live in the spec files, so this class is purely action + state read.
 */

import { expect, type Page } from "@playwright/test"

import type { ConsoleFixture } from "./ConsoleFixture.ts"

export interface ResolvedResult {
	parsedRows: Array<{ tag: string; value: string; confidence: string }>
	/**
	 * Definition list under `Resolved place`, empty when the WOF cascade returned no hits.
	 */
	resolved: Record<string, string>
	markerCount: number
}

export class GeocoderFixture {
	readonly #page: Page
	readonly console: ConsoleFixture

	constructor(page: Page, console: ConsoleFixture) {
		this.#page = page
		this.console = console
	}

	private get page(): Page {
		return this.#page
	}

	/**
	 * Navigate to the geocoder and wait until the classifier is loaded; network-idle
	 * is not the signal because the gazetteer's warm-up range reads keep the network
	 * busy past readiness, so the enabled address field is.
	 */
	async goto(query?: string): Promise<void> {
		const path = query ? `/?q=${encodeURIComponent(query)}` : "/"
		await this.page.goto(path, { waitUntil: "domcontentloaded" })
		await this.expectReady()
	}

	/**
	 * Wait for the cold-load (~39 MB ONNX + map style + sqlite-wasm) to complete, reading the address
	 * field's enabled state because `GeocoderControls` binds its `disabled` to `runtime.ready`;
	 * the options are the third argument (the second is the function's argument) and polling
	 * is on an interval because a page the browser treats as hidden fires no animation frames,
	 * while a load error the page reports ends the wait at once with that text.
	 */
	async expectReady(): Promise<void> {
		const outcome = await this.page.waitForFunction(
			() => {
				const error = document.querySelector(".mw-error")?.textContent?.trim()

				if (error) return { error }

				const field = document.querySelector("#mw-pipeline-input")

				return field instanceof HTMLInputElement && !field.disabled ? { ready: true } : null
			},
			undefined,
			{ timeout: 180_000, polling: 500 }
		)

		const value = await outcome.jsonValue()

		if (value && "error" in value) {
			throw new Error(`the geocoder reported a load error: ${value.error}`)
		}
	}

	async setAddress(text: string): Promise<void> {
		const input = this.page.locator("#mw-pipeline-input")
		await input.fill(text)
	}

	/**
	 * Type a partial address to trigger the place-autocomplete typeahead, then read the
	 * `Did you mean` suggestion texts once the debounced FST walk renders them.
	 */
	async readSuggestions(text: string): Promise<string[]> {
		await this.setAddress(text)
		const list = this.page.locator("#mw-demo-suggest-list")
		await list.waitFor({ state: "visible", timeout: 5000 }).catch(() => {})

		return this.page.locator("#mw-demo-suggest-list [role='option']").allTextContents()
	}

	async pickSuggestion(name: string): Promise<void> {
		await this.page.locator("#mw-demo-suggest-list [role='option']", { hasText: name }).first().click()
	}

	async addressValue(): Promise<string> {
		return this.page.locator("#mw-pipeline-input").inputValue()
	}

	async clickExample(label: string): Promise<void> {
		await this.page.locator(`button:has-text("${label}")`).first().click()
	}

	async submit(): Promise<void> {
		// Enter rather than a button: the search pill carries no submit control,
		// and a `type="search"` field submits its form on Enter.
		await this.page.locator("#mw-pipeline-input").press("Enter")

		// Block until the result panel renders so callers can immediately call `readResult()`;
		// the options are the third argument, as in `expectReady`.
		await this.page.waitForFunction(() => document.body.textContent?.includes("Parsed components"), undefined, {
			timeout: 60_000,
			polling: 500,
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
	 * Parse the resolved-place `coords` row into numbers; `NaN` components mean no coordinate resolved.
	 */
	async readCoords(): Promise<{ lat: number; lon: number }> {
		const { resolved } = await this.readResult()

		const [lat = Number.NaN, lon = Number.NaN] = (resolved["coords"] ?? "")
			.split(",")
			.map((s) => Number.parseFloat(s.trim()))

		return { lat, lon }
	}

	expectNear(coords: { lat: number; lon: number }, expected: { lat: number; lon: number }, tolDeg: number): void {
		const label = `resolved ${coords.lat},${coords.lon} should be within ${tolDeg}° of ${expected.lat},${expected.lon}`
		expect(Number.isFinite(coords.lat) && Number.isFinite(coords.lon), label).toBe(true)
		expect(coords.lat, label).toBeGreaterThan(expected.lat - tolDeg)
		expect(coords.lat, label).toBeLessThan(expected.lat + tolDeg)
		expect(coords.lon, label).toBeGreaterThan(expected.lon - tolDeg)
		expect(coords.lon, label).toBeLessThan(expected.lon + tolDeg)
	}

	async setTheme(theme: "light" | "dark"): Promise<void> {
		await this.page.evaluate((t) => {
			document.documentElement.setAttribute("data-theme", t)
		}, theme)

		// Allow the MutationObserver-driven setStyle + terrain re-wire to settle.
		await this.page.waitForTimeout(2000)
	}

	async expectMarkerVisible(): Promise<void> {
		const count = await this.page.locator(".maplibregl-marker").count()
		expect(count, "expected exactly one marker after submit").toBeGreaterThan(0)
	}
}
