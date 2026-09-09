/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The stylesheet rules, driven on the shapes that shipped broken.
 *
 *   Every case here is a defect that reached production on earth.mailwoman.ai: the candidate list that painted the
 *   user agent's near-black `buttontext` inside a dark sheet, the sheets that stood 34px past their own `max-height`
 *   because the cap measured the content box, the glass whose standard `backdrop-filter` the minifier dropped in
 *   favour of the `-webkit-` twin written after it, and the reduced-transparency fallback that named four of the six
 *   surfaces the material did.
 *
 *   The passing cases matter as much: each is a shape the rules must NOT report, because a rule nobody can satisfy
 *   gets an exemption instead of a fix.
 */

import { stylesheetDiagnostics } from "@mailwoman/repo-health/checks/stylesheet-contract"
import { describe, expect, it } from "vitest"

/**
 * The path the system-wide invariants are asserted on. A stylesheet at any other path is only run through the
 * detectors.
 */
const SYSTEM = "packages/react/styles.css"
const OTHER = "packages/earth/lib/styles/app.css"

const messages = (file: string, css: string) => stylesheetDiagnostics(file, css).map((d) => d.message)

describe("stylesheet-contract", () => {
	describe("the system stylesheet's invariants", () => {
		const RESET = "@layer reset { *, *::before, *::after { box-sizing: border-box; } }"
		const BUTTON = "@layer base { button { color: inherit; } }"

		it("passes when both are present", () => {
			expect(stylesheetDiagnostics(SYSTEM, `${RESET}\n${BUTTON}`)).toEqual([])
		})

		it("reports a missing box-sizing reset", () => {
			expect(messages(SYSTEM, BUTTON)).toEqual([expect.stringContaining("box-sizing: border-box")])
		})

		it("reports a missing button color default", () => {
			expect(messages(SYSTEM, RESET)).toEqual([expect.stringContaining("button { color: inherit }")])
		})

		it("asks for neither on another stylesheet", () => {
			expect(stylesheetDiagnostics(OTHER, ".a { color: red; }")).toEqual([])
		})
	})

	describe("an interactive background without a color", () => {
		it("reports the shape the candidate list shipped", () => {
			const css = ".mw-candidates__btn { background: transparent; cursor: pointer; font: inherit; }"

			expect(messages(OTHER, css)).toEqual([expect.stringContaining("states no color")])
		})

		it("accepts the same rule once it states a color", () => {
			const css = ".mw-candidates__btn { background: transparent; color: var(--x); cursor: pointer; }"

			expect(stylesheetDiagnostics(OTHER, css)).toEqual([])
		})

		it("accepts a state variant, which takes its color from the rule it varies", () => {
			const css = ".mw-btn:hover:not(:disabled) { background: var(--x); cursor: pointer; }"

			expect(stylesheetDiagnostics(OTHER, css)).toEqual([])
		})

		it("ignores a background on something that is not interactive", () => {
			expect(stylesheetDiagnostics(OTHER, ".panel { background: var(--x); }")).toEqual([])
		})
	})

	describe("a vendor pair the minifier collapses", () => {
		it("reports the standard property written first", () => {
			const css = ".glass { backdrop-filter: blur(2px); -webkit-backdrop-filter: blur(2px); }"

			expect(messages(OTHER, css)).toEqual([expect.stringContaining("declares `backdrop-filter` before")])
		})

		it("accepts the prefixed property first", () => {
			const css = ".glass { -webkit-backdrop-filter: blur(2px); backdrop-filter: blur(2px); }"

			expect(stylesheetDiagnostics(OTHER, css)).toEqual([])
		})

		it("accepts a standard property with no prefixed twin", () => {
			expect(stylesheetDiagnostics(OTHER, ".a { mask-image: linear-gradient(black, transparent); }")).toEqual([])
		})
	})

	describe("a material and its fallbacks", () => {
		const material = ".a, .b { background: var(--material-glass-background); }"

		it("reports a fallback that names fewer surfaces than the material", () => {
			const css = `${material}
				@media (prefers-reduced-transparency: reduce) {
					.a { background: var(--material-glass-fallback-background); }
				}`

			expect(messages(OTHER, css)).toEqual([expect.stringContaining("different set of surfaces")])
		})

		it("accepts a fallback naming the same surfaces in another order", () => {
			const css = `${material}
				@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
					.b, .a { background: var(--material-glass-fallback-background); }
				}`

			expect(stylesheetDiagnostics(OTHER, css)).toEqual([])
		})

		it("ignores the fallback colour used as an ordinary background", () => {
			// The chip's hover state and a sticky sheet header both paint this token on purpose, outside any guard.
			const css = `${material}
				.c:hover { background: var(--material-glass-fallback-background); }`

			expect(stylesheetDiagnostics(OTHER, css)).toEqual([])
		})
	})

	it("reads no declaration out of a comment", () => {
		const css = "/* .fake { background: red; cursor: pointer; } */\n.real { color: red; }"

		expect(stylesheetDiagnostics(OTHER, css)).toEqual([])
	})
})
