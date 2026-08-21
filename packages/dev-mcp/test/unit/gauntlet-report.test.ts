/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Fixtures are lifted verbatim from real runs on 2026-08-15/16, including the exact line that got skipped the day
 *   the gated-header rule was written.
 */

import { parseGauntletReport, summarizeGauntletReport } from "@mailwoman/dev-mcp/gauntlet-report"
import { describe, expect, it } from "vitest"

const STDOUT = `
=== Gauntlet · regression (352/354 gated cases pass, 203 tracked) ===
  ✗ es-op3-southeast-portopetro "Southeast, Carrer Passeig d'es Port, 15, 07691 Portopetro": coord 2.02km off
  ✗ gb-op2-st-margarets-hope "St Margaret's Hope, Orkney KW17 2QG": locality "null" ≠ "St Margaret's Hope"

tracked (known_fail / improvement_target, non-blocking):
  ~ ad-cs-andorra-la-vella [improvement_target]: coord 235.83km off (tol 25000m)

postcode-country coherence fired on 110/558 cases:
  · venue-nooyork-gravilliers-range "NooYork, 46/48 Rue des Gravilliers, 75003 Paris" → country scoped to FR

⚠ tracked cases that now PASS — promote to status=pass:
  + ni-ws-antiguo-cine-gonzalez-pluscode [improvement_target] now PASSES — promote to status=pass

verdict: FAIL
`

const STDERR = `[gauntlet] gazetteerPrior=ON postcodeCountryCoherence=default\n`

describe("parseGauntletReport", () => {
	it("reads the gated header, which is the verdict's denominator", () => {
		const report = parseGauntletReport(STDOUT, STDERR)

		expect(report.layers).toEqual([{ layer: "regression", gated_pass: 352, gated_total: 354, tracked: 203 }])
	})

	it("reads the verdict", () => {
		expect(parseGauntletReport(STDOUT, STDERR).verdict).toBe("FAIL")
	})

	it("carries the levers line, so two logs differing by a flag say which flag", () => {
		expect(parseGauntletReport(STDOUT, STDERR).levers).toContain("gazetteerPrior=ON")
	})

	it("reads the firing count separately from the verdict", () => {
		// An unchanged verdict from a mechanism that never ran proves nothing.
		expect(parseGauntletReport(STDOUT, STDERR).postcode_country_coherence_fired_on).toEqual({ n: 110, of: 558 })
	})

	it("collects gated failures and promote candidates", () => {
		const report = parseGauntletReport(STDOUT, STDERR)

		expect(report.gated_failures).toHaveLength(2)
		expect(report.gated_failures[0]).toContain("es-op3-southeast-portopetro")
		expect(report.now_passing).toEqual(["ni-ws-antiguo-cine-gonzalez-pluscode [improvement_target]"])
	})

	it("does not count a tracked non-blocking row as a gated failure", () => {
		// The `~` rows are non-blocking. Folding them in would inflate the failure count that a verdict rests on.
		expect(parseGauntletReport(STDOUT, STDERR).gated_failures.every((f) => !f.includes("andorra"))).toBe(true)
	})

	it("reports an absent verdict as absent, never as FAIL", () => {
		// A killed or crashed run and a graded failure are different facts.
		const report = parseGauntletReport("=== Gauntlet · regression (10/10 gated cases pass) ===\n", "")

		expect(report.verdict).toBeNull()
		expect(report.unparsed.join(" ")).toContain("did not reach a verdict")
	})

	it("says when there is no gated header rather than implying a clean run", () => {
		const report = parseGauntletReport("some unrelated output\n", "")

		expect(report.layers).toHaveLength(0)
		expect(report.unparsed.join(" ")).toContain("Do not read the absence of failures as a clean run")
	})

	it("says a missing firing line is not evidence about the pinned lever", () => {
		const report = parseGauntletReport("verdict: PASS\n", "")

		expect(report.postcode_country_coherence_fired_on).toBeNull()
		expect(report.unparsed.join(" ")).toContain("no other lever prints a firing count")
	})

	it("handles a multi-layer run", () => {
		const report = parseGauntletReport(
			"=== Gauntlet · regression (352/354 gated cases pass, 203 tracked) ===\n" +
				"=== Gauntlet · metamorphic (48/50 gated cases pass) ===\nverdict: PASS\n",
			""
		)

		expect(report.layers.map((l) => l.layer)).toEqual(["regression", "metamorphic"])
		expect(report.layers[1]!.tracked).toBe(0)
	})
})

describe("summarizeGauntletReport", () => {
	it("leads with the gated fraction, not the verdict word", () => {
		// Reading the tail instead of this line is how a 329/352 run got reported as "zero regressions" against a
		// 350/352 baseline on 2026-08-15.
		const summary = summarizeGauntletReport(parseGauntletReport(STDOUT, STDERR))

		expect(summary.startsWith("regression 352/354 gated")).toBe(true)
		expect(summary).toContain("Verdict FAIL")
		expect(summary).toContain("2 gated failures")
		expect(summary).toContain("fired on 110/558")
	})

	it("refuses to summarize a run with no header", () => {
		expect(summarizeGauntletReport(parseGauntletReport("nothing\n", ""))).toContain("no pass count to report")
	})
})
