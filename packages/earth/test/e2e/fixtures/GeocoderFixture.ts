/**
 * @file Page object for geocoder input, result read-back and controls for themes and examples.
 * Assertions live in the spec files. This class performs actions and reads state.
 */

import { BathymetryTileSetID, HillshadeTileSetID } from "@mailwoman/cartographer/base/terrain"
import { expect, type Page } from "@playwright/test"
import { TextSpliterator } from "spliterator"

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
	 * Navigate to the geocoder and wait until the classifier is loaded.
	 *
	 * Network-idle is not the signal because the gazetteer's warm-up range reads keep
	 * the network busy past readiness, so the enabled address field is.
	 */
	async goto(query?: string): Promise<void> {
		// The page leaves out the deck.gl scene because the geocoder specs read results.
		// which renders slowly on a software GPU.
		const path = query ? `/?no-3d&q=${encodeURIComponent(query)}` : "/?no-3d"
		await this.page.goto(path, { waitUntil: "domcontentloaded" })
		await this.expectReady()
	}

	/**
	 * Wait for the cold-load (~39 MB ONNX + map style + sqlite-wasm) to complete
	 * and for the map to load, reading the address field's enabled state because
	 * `GeocoderControls` binds its `disabled` to `runtime.ready`; the options are the
	 * third argument (the second is the function's argument) and polling is on an interval
	 * because a page the browser treats as hidden fires no animation frames,
	 * while a load error the page reports ends the wait at once with that text.
	 */
	async expectReady(): Promise<void> {
		const handle = await this.page.waitForFunction(
			() => {
				const error = document.querySelector(".mw-error")?.textContent?.trim()

				if (error) return { error }

				const field = document.querySelector("#mw-pipeline-input")

				if (!(field instanceof HTMLInputElement) || field.disabled) return null

				// The page exposes the map once its style and first tiles load,
				// and a test that moves the camera needs it.
				return "__mailwomanMapCanvas" in globalThis ? { ready: true } : null
			},
			undefined,
			{ timeout: 180_000, polling: 500 }
		)

		const value = await handle.jsonValue()

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
		// Wait for at least one option rather than a visible list.
		// A slow FST walk used to fall through the swallowed timeout and fail on a misleading empty-list diff.
		const options = this.page.locator("#mw-demo-suggest-list [role='option']")
		await options.first().waitFor({ state: "attached", timeout: 5000 })

		return options.allTextContents()
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
		// The search pill has no submit control.
		// A `type="search"` field submits its form when the user presses Enter.
		await this.page.locator("#mw-pipeline-input").press("Enter")

		// Block until the result panel renders so callers can immediately call `readResult()`;
		// the options are the third argument, as in `expectReady`.
		await this.page.waitForFunction(() => document.body.textContent?.includes("Parsed components"), undefined, {
			timeout: 60_000,
			polling: 500,
		})

		await this.waitForMapIdle()
	}

	/**
	 * Submit another query on an already-loaded page and wait for the result panel to update.
	 *
	 * `submit()`'s panel check passes at once when an earlier result is already on screen.
	 * This snapshots the parsed-rows table before pressing Enter and waits for its text to change.
	 * Use `submit()` for the first query after `goto()`.
	 */
	async submitForUpdate(): Promise<void> {
		const previousRows = await this.page.evaluate(() => document.querySelector("tbody")?.textContent ?? null)
		await this.page.locator("#mw-pipeline-input").press("Enter")

		await this.page.waitForFunction(
			(previous) => {
				if (!document.body.textContent?.includes("Parsed components")) return false

				return (document.querySelector("tbody")?.textContent ?? null) !== previous
			},
			previousRows,
			{ timeout: 180_000, polling: 500 }
		)

		await this.waitForMapIdle()
	}

	/**
	 * Wait out the map's response to a result or theme change (fitBounds, terrain re-wire) by
	 * polling maplibre's own moving and source-loading flags instead of sleeping a fixed interval.
	 *
	 * The terrain sources are skipped.
	 * They shade the map from a third-party tile host, and no assertion reads them.
	 */
	async waitForMapIdle(timeout = 15_000): Promise<void> {
		await this.page.waitForFunction(
			(skipped) => {
				interface MapHandle {
					isMoving: () => boolean
					isSourceLoaded: (id: string) => boolean
					getStyle: () => { sources?: Record<string, unknown> } | undefined
				}

				const map = (globalThis as { __mailwomanMapCanvas?: MapHandle }).__mailwomanMapCanvas

				if (!map) return true

				if (map.isMoving()) return false

				const sources = Object.keys(map.getStyle()?.sources ?? {}).filter((id) => !skipped.includes(id))

				return sources.every((id) => map.isSourceLoaded(id))
			},
			[HillshadeTileSetID, BathymetryTileSetID] as string[],
			{ timeout, polling: 100 }
		)
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

		const [lat = Number.NaN, lon = Number.NaN] = TextSpliterator.from(resolved["coords"] ?? "", { delimiter: "," })
			.map((s) => Number.parseFloat(s))
			.toArray()

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

		// Wait out the MutationObserver-driven setStyle + terrain re-wire.
		await this.waitForMapIdle()
	}

	async expectMarkerVisible(): Promise<void> {
		const count = await this.page.locator(".maplibregl-marker").count()
		expect(count, "expected exactly one marker after submit").toBeGreaterThan(0)
	}
}
