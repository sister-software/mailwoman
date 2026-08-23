/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file `decideArc` — the arithmetic that eight training runs got wrong by eye.
 *
 *   Each case here is a verdict that was actually reached incorrectly on 2026-08-23, encoded so it cannot be reached
 *   incorrectly again. The refusal cases matter most: a tool that reports a confident number when its controls say it
 *   may not is worse than one that reports nothing.
 */

import { type ArcLeg, decideArc, renderArc } from "@mailwoman/dev-mcp/arc"
import { describe, expect, it } from "vitest"

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
		...extra,
	}
}

describe("decideArc", () => {
	it("subtracts the NULL, because the fine-tune tax is not the lever's fault", () => {
		// The arc's actual numbers: v4.11.0 read -13 against shipped while the null read -5. Eight of those thirteen
		// were the cost of touching the base, and reporting thirteen sent two more runs chasing a shard that was
		// responsible for five.
		const arc = decideArc(leg("control", 0, 0, { differed: 0 }), leg("null", 5, 10), leg("candidate", 5, 18))

		expect(arc.attributableRegressions).toBe(8)
		expect(arc.attributableNet).toBe(-8)
	})

	it("REFUSES to attribute when the self-control is dirty", () => {
		// A rig that disagrees with itself cannot be asked about a candidate. The candidate numbers are still reported —
		// withholding them would just get them re-measured — but the verdict says they are not evidence.
		const arc = decideArc(leg("control", 0, 3, { differed: 3 }), leg("null", 5, 10), leg("candidate", 40, 2))

		expect(arc.verdict).toBe("unattributable")
		expect(arc.attributable).toBe(false)
		expect(arc.reasons[0]).toContain("SELF-CONTROL DIRTY")
		// Even a candidate that looks excellent does not get through on a dirty rig.
		expect(arc.candidate.net).toBe(38)
	})

	it("says a missing control is a MISSING CONTROL, not a passing one", () => {
		// The meaning-of-zero rule applied to the protocol itself: no self-control leg is not a quiet rig.
		const arc = decideArc(undefined, undefined, leg("candidate", 12, 4))

		expect(arc.attributableNet).toBeUndefined()
		expect(arc.reasons.some((r) => r.includes("No self-control leg ran"))).toBe(true)
		expect(arc.reasons.some((r) => r.includes("upper bound"))).toBe(true)
	})

	it("blocks a D-rule locale regression regardless of a winning net", () => {
		// Iron rule 6. Net +37 does not buy a regression in France.
		const arc = decideArc(
			leg("control", 0, 0, { differed: 0 }),
			leg("null", 0, 0),
			leg("candidate", 40, 3, { regressedByCountry: { FR: 1, US: 2 } })
		)

		expect(arc.verdict).toBe("hold")
		expect(arc.dRuleViolations).toEqual([{ country: "FR", n: 1 }])
	})

	it("ships only when the controls are clean, the net is positive, and it survives the null", () => {
		const arc = decideArc(
			leg("control", 0, 0, { differed: 0 }),
			leg("null", 2, 8),
			leg("candidate", 30, 6, { regressedByCountry: { US: 6 } })
		)

		expect(arc.verdict).toBe("ship")
		// +24 gross, and it still buys back the null's -6.
		expect(arc.attributableNet).toBe(30)
	})

	it("holds a candidate that beats shipped but not the null", () => {
		// The trap the arc walked into from the other side: -3 looks like a small regression and is actually an
		// IMPROVEMENT over a -5 null. This one is the reverse — positive against shipped, negative against the placebo.
		const arc = decideArc(leg("control", 0, 0, { differed: 0 }), leg("null", 12, 2), leg("candidate", 6, 3))

		expect(arc.candidate.net).toBe(3)
		expect(arc.attributableNet).toBe(-7)
		expect(arc.verdict).toBe("hold")
	})

	it("renders the verdict first and the ADDRESSES last, never only a count", () => {
		const arc = decideArc(
			leg("control", 0, 0, { differed: 0 }),
			leg("null", 0, 0),
			leg("candidate", 1, 1, {
				regressedByCountry: { GB: 1 },
				regressedInputs: ["Ye Three Lords, 27 Minories, London EC3N 1DE"],
			})
		)

		const out = renderArc(arc)

		// oxlint-disable-next-line mailwoman/prefer-spliterator -- a rendered arc is a handful of lines, in memory already
		expect(out.split("\n")[0]).toBe("verdict: hold")
		expect(out).toContain("Ye Three Lords, 27 Minories, London EC3N 1DE")
	})
})
