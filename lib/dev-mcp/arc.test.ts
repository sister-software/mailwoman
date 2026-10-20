/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file `decideArc`: training attribution against the self-control and null legs, and release eligibility read
 *   from the release verdict tied to the candidate artifact and specification version.
 */

import { describe, expect, it } from "vitest"

import { type ArcLeg, type BoardFinding, decideArc, type ReleaseEvidence, renderArc, summarizeArc } from "#dev-mcp/arc"

const CANDIDATE_SHA = "c".repeat(64)

function leg(label: string, improved: number, regressed: number, extra: Partial<ArcLeg> = {}): ArcLeg {
	return {
		label,
		weights: `/tmp/${label}`,
		improved,
		regressed,
		net: improved - regressed,
		differed: improved + regressed,
		of: 649,
		regressedByCountry: {},
		regressedInputs: [],
		improvedInputs: [],
		regressedRows: [],
		runID: null,
		...extra,
	}
}

function verdict(outcome: string, overrides: Record<string, unknown> = {}) {
	return {
		specVersion: "1",
		outcome,
		reasons: [`the verdict says ${outcome}`],
		artifacts: { published: "p".repeat(64), candidate: CANDIDATE_SHA },
		...overrides,
	}
}

function evidence(value: unknown): ReleaseEvidence {
	return {
		verdict: value,
		verdictPath: value == null ? null : "/tmp/verdict.json",
		candidateSHA256: CANDIDATE_SHA,
		specVersion: "1",
	}
}

const CLEAN = leg("control", 0, 0, { differed: 0 })

describe("decideArc release eligibility", () => {
	it("refuses a verdict evaluated for another artifact", () => {
		expect(() =>
			decideArc({
				control: CLEAN,
				null: null,
				candidate: leg("candidate", 5, 1),
				release: evidence(
					verdict("pass", {
						artifacts: { published: "p", candidate: "d".repeat(64) },
					})
				),
				shape: "from-scratch",
			})
		).toThrow(/sha256 d{64}.*candidate under test is c{64}/)
	})

	it("refuses a verdict evaluated against another spec version", () => {
		expect(() =>
			decideArc({
				control: CLEAN,
				null: null,
				candidate: leg("candidate", 5, 1),
				release: evidence(verdict("pass", { specVersion: "0" })),
				shape: "from-scratch",
			})
		).toThrow(/release spec 0, and the current spec is 1/)
	})

	it("refuses a verdict whose outcome cannot be read rather than reading it as a pass", () => {
		expect(() =>
			decideArc({
				control: CLEAN,
				null: null,
				candidate: leg("candidate", 5, 1),
				release: evidence(verdict("ship")),
			})
		).toThrow(/outcome ship/)
	})

	it("reads a missing verdict as insufficient evidence, never a pass", () => {
		const arc = decideArc({
			control: CLEAN,
			null: leg("null", 0, 0),
			candidate: leg("candidate", 40, 0),
			release: evidence(null),
		})

		expect(arc.release.outcome).toBe("insufficient_evidence")
		expect(arc.release.reasons[0]).toContain("No release verdict was supplied")
		expect(arc.attribution.attributable).toBe(true)
	})

	it("takes the outcome from a matching verdict", () => {
		for (const outcome of ["pass", "fail", "insufficient_evidence"] as const) {
			const arc = decideArc({
				control: CLEAN,
				null: null,
				candidate: leg("c", 1, 0),
				release: evidence(verdict(outcome)),
			})

			expect(arc.release.outcome).toBe(outcome)
			expect(arc.release.reasons).toEqual([`the verdict says ${outcome}`])
		}
	})

	it("reports board regressions with their addresses and lets them decide nothing", () => {
		const findings: BoardFinding[] = [
			{
				input: "Ye Three Lords, 27 Minories, London EC3N 1DE",
				country: "GB",
				published: { postcode: "EC3N 1DE" },
				candidate: { locality: "EC3N 1DE" },
				issues: ["postcode: expected EC3N 1DE, got none"],
			},
			{
				input: "8 Rue de Rivoli, 75004 Paris",
				country: "FR",
				published: null,
				candidate: null,
				issues: [],
			},
		]

		const arc = decideArc({
			control: CLEAN,
			null: leg("null", 0, 0),
			candidate: leg("candidate", 3, 40, {
				regressedByCountry: { GB: 1, FR: 1 },
				regressedRows: findings,
			}),
			release: evidence(verdict("pass")),
		})

		expect(arc.release.outcome).toBe("pass")
		expect(arc.findings).toEqual(findings)

		const out = renderArc(arc)

		expect(out).toContain("- Ye Three Lords, 27 Minories, London EC3N 1DE [GB]")
		expect(out).toContain("postcode: expected EC3N 1DE, got none")
		expect(out).toContain("- 8 Rue de Rivoli, 75004 Paris [FR]")
	})
})

describe("decideArc training attribution", () => {
	it("subtracts the NULL, because the fine-tune tax is not the change's fault", () => {
		const arc = decideArc({
			control: CLEAN,
			null: leg("null", 5, 10),
			candidate: leg("candidate", 5, 18),
			release: evidence(null),
		})

		expect(arc.attribution.regressions).toBe(8)
		expect(arc.attribution.net).toBe(-8)
		expect(arc.attribution.reasons.some((reason) => reason.includes("Attributable net is -8"))).toBe(true)
	})

	it("REFUSES to attribute when the self-control is dirty, whatever the release verdict says", () => {
		const arc = decideArc({
			control: leg("control", 0, 3, { differed: 3 }),
			null: leg("null", 5, 10),
			candidate: leg("candidate", 40, 2),
			release: evidence(verdict("pass")),
		})

		expect(arc.attribution.attributable).toBe(false)
		expect(arc.attribution.reasons[0]).toContain("SELF-CONTROL DIRTY")
		expect(arc.candidate.net).toBe(38)
		expect(arc.release.outcome).toBe("pass")
		expect(renderArc(arc)).toContain("attribution: unattributable")
	})

	it("says a missing control is a MISSING CONTROL, not a passing one", () => {
		const arc = decideArc({
			control: null,
			null: null,
			candidate: leg("candidate", 12, 4),
			release: evidence(null),
		})

		expect(arc.attribution.net).toBeNull()
		expect(arc.attribution.reasons.some((r) => r.includes("No self-control leg ran"))).toBe(true)
		expect(arc.attribution.reasons.some((r) => r.includes("upper bound"))).toBe(true)
	})

	it("does not charge a FROM-SCRATCH run a fine-tune tax it never paid", () => {
		const arc = decideArc({
			control: CLEAN,
			null: null,
			candidate: leg("candidate", 20, 4),
			release: evidence(null),
			shape: "from-scratch",
		})

		expect(arc.shape).toBe("from-scratch")
		expect(arc.attribution.reasons.some((r) => r.includes("upper bound"))).toBe(false)
		expect(arc.attribution.reasons.some((r) => r.includes("none is applicable"))).toBe(true)
		expect(summarizeArc(arc)).not.toContain("upper bound")
		expect(summarizeArc(arc)).toContain("inherits no base")
	})

	it("renders release eligibility first and BOTH halves of the trade", () => {
		const arc = decideArc({
			control: CLEAN,
			null: null,
			candidate: leg("candidate", 1, 1, {
				improvedInputs: ["12 MG Road, Indiranagar, Bengaluru, Karnataka 560038, India"],
				regressedRows: [
					{
						input: "Unter den Linden",
						country: "DE",
						published: null,
						candidate: null,
						issues: [],
					},
				],
			}),
			release: evidence(null),
			shape: "from-scratch",
		})

		const out = renderArc(arc)

		// oxlint-disable-next-line mailwoman/prefer-spliterator -- a rendered arc is a handful of lines, in memory already
		expect(out.split("\n")[0]).toBe(`release: insufficient_evidence (spec 1, candidate sha256 ${CANDIDATE_SHA})`)
		expect(out).toContain("+ 12 MG Road, Indiranagar, Bengaluru, Karnataka 560038, India")
		expect(out).toContain("- Unter den Linden [DE]")
	})
})
