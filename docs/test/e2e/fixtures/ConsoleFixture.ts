/**
 * @file Console + page-error capture fixture.
 *
 *   Buffers every console message, pageerror, and matching requestfailed event for the test's
 *   lifetime. Test bodies call `assertNoFailEvents()` to enforce the blocklist + ignorelist defined
 *   in `console-policy.ts`, or pull the raw `events` array for ad-hoc inspection.
 *
 *   Pattern ported from authentik's PageFixture base class — minus the pino logger (we let
 *   Playwright's `list` reporter handle stdout instead).
 */

import type { Page, Request } from "@playwright/test"

import { classify, isIgnored, listFailures } from "../utils/console-policy.js"

export interface CapturedEvent {
	kind: "console" | "pageerror" | "requestfailed"
	severity: "log" | "info" | "warning" | "error" | "debug"
	text: string
}

export class ConsoleFixture {
	readonly events: CapturedEvent[] = []
	#baseHost: string

	constructor(page: Page) {
		this.#baseHost = ""
		const wireBaseURL = (): void => {
			try {
				const url = new URL(page.url())
				this.#baseHost = url.host
			} catch {
				/* about:blank — wait for first nav */
			}
		}

		page.on("console", (msg) => {
			const text = msg.text()
			if (isIgnored(text)) return
			this.events.push({
				kind: "console",
				severity: msg.type() as CapturedEvent["severity"],
				text,
			})
		})

		page.on("pageerror", (e) => {
			this.events.push({ kind: "pageerror", severity: "error", text: e.message })
		})

		page.on("requestfailed", (req: Request) => {
			wireBaseURL()
			const url = req.url()
			// Only capture failures we care about — first-party assets + the /mailwoman/* bundle.
			// Third-party CDN flakiness shouldn't fail the suite.
			if (!url.includes(this.#baseHost) && !url.includes("/mailwoman/")) return
			const err = req.failure()?.errorText ?? "unknown"
			this.events.push({
				kind: "requestfailed",
				severity: "error",
				text: `${req.method()} ${url} (${err})`,
			})
		})
	}

	/**
	 * Throw if any captured event matches the FAIL_PATTERNS list (style/terrain races, MapLibre
	 * teardown errors, sqlite/onnx unhandled throws). Pass-through for events that are merely noisy.
	 */
	assertNoFailEvents(): void {
		const failures = listFailures(this.events.map((e) => e.text))
		if (failures.length === 0) return
		const lines = failures.map((f, i) => `  ${i + 1}. ${f}`).join("\n")
		throw new Error(`Captured ${failures.length} console/page error(s):\n${lines}`)
	}

	/** Filter helper for ad-hoc test assertions. */
	matching(pattern: RegExp): CapturedEvent[] {
		return this.events.filter((e) => pattern.test(e.text))
	}

	/** Snapshot of all classifications, for debug. */
	summary(): { failures: string[]; noise: string[] } {
		const failures: string[] = []
		const noise: string[] = []
		for (const e of this.events) {
			if (classify(e.text) === "fail") failures.push(e.text)
			else noise.push(e.text)
		}
		return { failures, noise }
	}
}
