/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests for the ablation layer's GRACEFUL-DEGRADATION EXPECTATION MODEL, at fixture scale against a fake gazetteer.
 *
 *   The fake is the point. The model's whole claim is that an expectation is computed from the components a deletion
 *   LEFT BEHIND — never from the variant's own output — and the only way to prove a non-dependency is to hold
 *   everything else fixed and vary the output. `deriveExpectedRung` takes no result argument at all, so the compiler
 *   already forbids the obvious version of the mistake; the test forbids the version where someone adds one later.
 *
 *   Four other properties are pinned here because each has a silent failure mode:
 *
 *   - A zero-extent bbox read as a radius of zero makes half the locality rungs pinpoints, and every honest coarsening
 *       then fails. It looks like a working grader producing bad news.
 *   - A substitution that passes because the coordinate happened to stay put hides exactly the rows the map exists to
 *       surface (S-2's finding 3).
 *   - An abstention graded as a loss and a lost answer graded as an abstention are the same arithmetic and opposite
 *       operator actions.
 *   - The anchor floor: without it, a row that was already resolving to its locality centroid charges every one of its
 *       components with a failure it did not cause.
 */

import {
	ABSTAIN_RUNG,
	type AblationGazetteerProbe,
	type AblationLadder,
	ablationLadderFromChain,
	type AblationPlace,
	bboxRadiusKm,
	buildCaseLadder,
	DECISIVE_MARGIN_LOG10,
	deriveExpectedRung,
	dominanceMarginLog10,
	expectFor,
	gradeAgainstLadder,
	overrideToExpectedRung,
	RUNG_RADIUS_FLOOR_KM,
	residualWords,
	rungRadiusKm,
	UNCONSTRAINED_RUNG,
	withoutComponent,
} from "mailwoman/eval-harness/gauntlet/ablation-expectation"
import { describe, expect, it } from "vitest"

/**
 * A gazetteer place. `negRank` is `-log10(population + 1)`, so a bigger place is a SMALLER number.
 */
function place(over: Partial<AblationPlace> & { id: number; name: string; placetype: string }): AblationPlace {
	return {
		country: "US",
		lat: 40,
		lon: -74,
		bbox: null,
		negRank: 0,
		population: null,
		...over,
	}
}

const SPRINGFIELD_IL = place({
	id: 1,
	name: "Springfield",
	placetype: "locality",
	lat: 39.8,
	lon: -89.65,
	negRank: -5.06,
})

const SPRINGFIELD_MA = place({
	id: 2,
	name: "Springfield",
	placetype: "locality",
	lat: 42.1,
	lon: -72.59,
	negRank: -5.19,
})

const SANGAMON = place({ id: 3, name: "Sangamon", placetype: "county", lat: 39.76, lon: -89.66 })
const ILLINOIS = place({ id: 4, name: "Illinois", placetype: "region", lat: 40, lon: -89.2 })
const USA = place({ id: 5, name: "United States", placetype: "country", lat: 39.5, lon: -98.35 })

/**
 * The Springfield, IL ladder: rooftop → locality → county → region → country.
 */
const LADDER: AblationLadder = ablationLadderFromChain(
	{ lat: 39.8017, lon: -89.6437 },
	[SPRINGFIELD_IL, SANGAMON, ILLINOIS, USA],
	0.5
)

/**
 * A gazetteer that answers from fixtures. `named` honours the country filter only — the bbox filter is the reader's job
 * and is covered where it matters (`ablation-gazetteer.ts`).
 */
function fakeGazetteer(over: Partial<AblationGazetteerProbe> = {}): AblationGazetteerProbe {
	const byName: Record<string, AblationPlace[]> = {
		Springfield: [SPRINGFIELD_MA, SPRINGFIELD_IL],
		Illinois: [ILLINOIS],
		"United States": [USA],
		"62701": [place({ id: 6, name: "62701", placetype: "postalcode", lat: 39.8, lon: -89.65 })],
	}

	return {
		place: (id) => [SPRINGFIELD_IL, SANGAMON, ILLINOIS, USA].find((p) => p.id === id) ?? null,
		lineage: () => [SANGAMON, ILLINOIS, USA],
		containingChain: () => [SPRINGFIELD_IL, SANGAMON, ILLINOIS, USA],
		named: (name, opts) => (byName[name] ?? []).filter((p) => !opts?.country || p.country === opts.country),
		...over,
	}
}

describe("bboxRadiusKm — a zero-extent bbox is ABSENCE, not a radius of zero", () => {
	it("measures the furthest corner", () => {
		const km = bboxRadiusKm({ lat: 40, lon: -74, bbox: { minLat: 39.9, maxLat: 40.1, minLon: -74.1, maxLon: -73.9 } })

		expect(km).toBeGreaterThan(13)
		expect(km).toBeLessThan(16)
	})

	// `spr` stores an unset bbox as `min == max` (NOT NULL DEFAULT 0) — 49.2% of localities, 59.1% of countries.
	it("returns null for a degenerate bbox rather than 0", () => {
		expect(bboxRadiusKm({ lat: 40, lon: -74, bbox: { minLat: 40, maxLat: 40, minLon: -74, maxLon: -74 } })).toBeNull()
	})

	it("returns null for a sub-100 m rounding artifact", () => {
		expect(
			bboxRadiusKm({
				lat: 40,
				lon: -74,
				bbox: { minLat: 39.9999, maxLat: 40.0001, minLon: -74.0001, maxLon: -73.9999 },
			})
		).toBeNull()
	})

	it("returns null when there is no bbox at all", () => {
		expect(bboxRadiusKm({ lat: 40, lon: -74, bbox: null })).toBeNull()
	})
})

describe("rungRadiusKm — no rung without a radius", () => {
	it("prefers a real bbox when it is wider than the placetype floor", () => {
		const wide = place({
			id: 9,
			name: "Illinois",
			placetype: "region",
			bbox: { minLat: 37, maxLat: 42.5, minLon: -91.5, maxLon: -87.5 },
		})

		expect(rungRadiusKm(wide)).toMatchObject({ radiusSource: "bbox" })
		expect(rungRadiusKm(wide)!.radiusKM).toBeGreaterThan(RUNG_RADIUS_FLOOR_KM["region"]!)
	})

	it("falls back to the measured placetype floor when the bbox is absent", () => {
		expect(rungRadiusKm(SPRINGFIELD_IL)).toEqual({
			radiusKM: RUNG_RADIUS_FLOOR_KM["locality"],
			radiusSource: "placetype-floor",
		})
	})

	// The PFX1 honesty rule: a coordinate without a radius is not a claim, so the rung is dropped and reported.
	it("refuses a rung whose placetype has no floor and no bbox", () => {
		expect(rungRadiusKm(place({ id: 8, name: "Some Campus", placetype: "campus" }))).toBeNull()
	})
})

describe("ablationLadderFromChain", () => {
	it("puts the row's own answer at depth 0 with the row's own tolerance", () => {
		expect(LADDER.rungs[0]).toMatchObject({ depth: 0, kind: "base", radiusKM: 0.5, radiusSource: "row-tolerance" })
	})

	it("walks outward, deepest first", () => {
		expect(LADDER.rungs.map((r) => r.kind)).toEqual(["base", "locality", "county", "region", "country"])
	})

	// A gazetteer bbox that makes an ancestor TIGHTER than its child would pass the child and fail the parent for the
	// same point, which is not a ladder.
	it("keeps radii non-decreasing going up", () => {
		const radii = LADDER.rungs.map((r) => r.radiusKM)

		expect(radii).toEqual(radii.toSorted((a, b) => a - b))
	})

	it("reports a dropped rung as a GAP rather than shortening the ladder silently", () => {
		const withCampus = ablationLadderFromChain(
			{ lat: 39.8, lon: -89.65 },
			[place({ id: 8, name: "Some Campus", placetype: "campus" }), SPRINGFIELD_IL],
			0.5
		)

		expect(withCampus.rungs.map((r) => r.kind)).toEqual(["base", "locality"])
		expect(withCampus.gaps).toHaveLength(1)
		expect(withCampus.gaps[0]).toMatchObject({ placetype: "campus", name: "Some Campus" })
	})
})

describe("dominanceMarginLog10 — the measured decisiveness cut", () => {
	it("is infinite for a single candidate: no contest", () => {
		expect(dominanceMarginLog10([SPRINGFIELD_IL])).toBe(Infinity)
	})

	it("is the log10 population gap between the top two", () => {
		expect(dominanceMarginLog10([SPRINGFIELD_MA, SPRINGFIELD_IL])).toBeCloseTo(0.13, 2)
	})

	it("puts the Springfield contest UNDER the cut — which is what makes abstention the right answer", () => {
		expect(dominanceMarginLog10([SPRINGFIELD_MA, SPRINGFIELD_IL])).toBeLessThan(DECISIVE_MARGIN_LOG10)
	})
})

describe("deriveExpectedRung — computed from what REMAINS", () => {
	const gz = fakeGazetteer()

	it("holds the rooftop when a postcode and the street evidence both survive", () => {
		const expected = deriveExpectedRung(
			{ postcode: "62701", street: "Evergreen Terrace", house_number: "742" },
			LADDER,
			gz
		)

		expect(expected).toMatchObject({ kind: "rung", depth: 0 })
	})

	// The operator's own example: dropping the country from an address the region still pins must NOT be graded as a
	// break — the surviving evidence keeps the deep rung.
	it("keeps the deep rung when only the country goes", () => {
		const expected = deriveExpectedRung(
			{ locality: "Springfield", region: "Illinois", street: "Evergreen Terrace", house_number: "742" },
			LADDER,
			gz
		)

		expect(expected).toMatchObject({ kind: "rung", depth: 0 })
	})

	it("coarsens to the region when only the region survives", () => {
		expect(deriveExpectedRung({ region: "Illinois" }, LADDER, gz)).toMatchObject({ kind: "rung", depth: 3 })
	})

	it("coarsens to the country when only the country survives", () => {
		expect(deriveExpectedRung({ country: "United States" }, LADDER, gz)).toMatchObject({ kind: "rung", depth: 4 })
	})

	// The headline case: a bare ambiguous name with nothing else to lean on. ABSTAINING is the correct answer.
	it("expects ABSTENTION for a bare name no population winner settles", () => {
		const expected = deriveExpectedRung({ locality: "Springfield" }, LADDER, gz)

		expect(expected.kind).toBe(ABSTAIN_RUNG)
		expect(expected.why).toContain("2 distinct places")
	})

	it("expects abstention when nothing at all names a place", () => {
		expect(deriveExpectedRung({ unit: "Suite 400" }, LADDER, gz).kind).toBe(ABSTAIN_RUNG)
	})

	// Ambiguity plus a handle this model cannot evaluate is NOT a licence to demand abstention.
	it("declines to constrain when a venue survives alongside the ambiguous name", () => {
		const expected = deriveExpectedRung({ locality: "Springfield", venue: "Kwik-E-Mart" }, LADDER, gz)

		expect(expected.kind).toBe(UNCONSTRAINED_RUNG)
		expect(expected.why).toContain("cannot evaluate it")
	})

	it("flags a homonym takeover instead of pretending the ladder is pinned", () => {
		const paris = place({ id: 20, name: "Paris", placetype: "locality", country: "FR", lat: 48.85, lon: 2.35 })

		const expected = deriveExpectedRung({ locality: "Paris" }, LADDER, fakeGazetteer({ named: () => [paris] }))

		expect(expected).toMatchObject({ kind: ABSTAIN_RUNG, homonymTakeover: true })
	})
})

/**
 * THE CIRCULARITY GUARD.
 *
 * An expectation derived from the variant's own output would grade the pipeline against itself and pass everything.
 * `deriveExpectedRung` takes no result argument, so the direct version cannot compile; these pin the property so a
 * later "just peek at the answer" refactor fails loudly instead of quietly making the layer useless.
 */
describe("the expectation is INVARIANT to the variant's output", () => {
	const gz = fakeGazetteer()
	const remaining = { locality: "Springfield", region: "Illinois" }

	it("is byte-identical across four wildly different ablated answers", () => {
		const expected = deriveExpectedRung(remaining, LADDER, gz)

		const outcomes = [
			{ lat: 39.8017, lon: -89.6437 }, // the rooftop
			{ lat: 42.1015, lon: -72.5898 }, // the WRONG Springfield, 1,400 km away
			{ lat: 39.76, lon: -89.66 }, // the county centroid
			{ lat: null, lon: null }, // abstained
		]

		for (const outcome of outcomes) {
			// Grading consumes the outcome; deriving must not. Re-derive after each grade and compare.
			gradeAgainstLadder({ expected, ladder: LADDER, ...outcome, slot: "absent", anchorRungDepth: 0 })

			expect(deriveExpectedRung(remaining, LADDER, gz)).toEqual(expected)
		}
	})

	it("changes only when the SURVIVING components change", () => {
		const withRegion = deriveExpectedRung({ locality: "Springfield", region: "Illinois" }, LADDER, gz)
		const withoutRegion = deriveExpectedRung({ locality: "Springfield" }, LADDER, gz)

		expect(withRegion.kind).toBe("rung")
		expect(withoutRegion.kind).toBe(ABSTAIN_RUNG)
	})

	it("removes the deleted component without leaving an undefined own property behind", () => {
		const remainingAfter = withoutComponent({ locality: "Springfield", region: "Illinois" }, "region")

		expect("region" in remainingAfter).toBe(false)
		expect(remainingAfter).toEqual({ locality: "Springfield" })
	})
})

describe("residualWords — the corpus types less than the input carries", () => {
	it("finds the words no surviving component accounts for", () => {
		expect(residualWords("181 Rue du Chevaleret, Paris", {})).toEqual(["rue", "chevaleret", "paris"])
	})

	it("ignores words a surviving component already accounts for", () => {
		expect(residualWords("181 Rue du Chevaleret, Paris", { street: "Rue du Chevaleret", locality: "Paris" })).toEqual(
			[]
		)
	})

	it("ignores bare numbers and two-letter tokens — neither pins a place", () => {
		expect(residualWords("742 A B, IL", { region: "IL" })).toEqual([])
	})

	// `fr-chevaleret-rooftop` asserts ONLY its postcode. Deleting it leaves the model an empty component set, and an
	// empty set used to read as "nothing names a place" → abstain → the correct rooftop graded overconfident.
	it("turns an otherwise-ABSTAIN expectation into an unconstrained one", () => {
		const gz = fakeGazetteer()

		expect(deriveExpectedRung({}, LADDER, gz).kind).toBe(ABSTAIN_RUNG)
		expect(deriveExpectedRung({}, LADDER, gz, ["chevaleret", "paris"]).kind).toBe(UNCONSTRAINED_RUNG)
	})

	// …but untyped words can only STOP an abstention, never deepen a rung expectation: they are evidence of unknown
	// strength, and treating them as strong would be the same guess in the other direction.
	it("does not deepen a rung expectation", () => {
		const withResidual = deriveExpectedRung({ region: "Illinois" }, LADDER, fakeGazetteer(), ["evergreen", "terrace"])

		expect(withResidual).toMatchObject({ kind: "rung", depth: 3 })
	})
})

describe("gradeAgainstLadder", () => {
	const base = { ladder: LADDER, slot: "absent" as const, anchorRungDepth: 0 }
	const rung = (depth: number) => ({ kind: "rung" as const, depth, why: "test" })

	it("passes an answer that held at the base rung", () => {
		const graded = gradeAgainstLadder({ ...base, expected: rung(0), lat: 39.8017, lon: -89.6437 })

		expect(graded).toMatchObject({ grade: "held", achievedRungDepth: 0, degradedRungs: 0 })
	})

	// The whole point of the layer: coarser-and-honest is a PASS, and the rung-depth delta is recorded as data.
	it("passes a coarsening the surviving evidence justifies, and records how far it fell", () => {
		const graded = gradeAgainstLadder({ ...base, expected: rung(3), lat: 39.76, lon: -89.66 })

		expect(graded).toMatchObject({ grade: "degraded", achievedRungDepth: 1, degradedRungs: 1 })
	})

	it("fails an answer coarser than the surviving evidence justifies", () => {
		const graded = gradeAgainstLadder({ ...base, expected: rung(0), lat: 40, lon: -89.2 })

		expect(graded.grade).toBe("coarser")
	})

	it("fails an answer that left the ladder entirely", () => {
		const graded = gradeAgainstLadder({ ...base, expected: rung(4), lat: 48.85, lon: 2.35 })

		expect(graded).toMatchObject({ grade: "wrong", achievedRungDepth: null })
	})

	// The `unresolvedCount` split: two different operator actions, so two different grades.
	it("passes an abstention when the expected rung IS abstain", () => {
		const graded = gradeAgainstLadder({
			...base,
			expected: { kind: ABSTAIN_RUNG, why: "144 Springfields" },
			lat: null,
			lon: null,
		})

		expect(graded.grade).toBe("correctlyAbstained")
	})

	it("fails a LOST answer where a rung was expected", () => {
		expect(gradeAgainstLadder({ ...base, expected: rung(3), lat: null, lon: null }).grade).toBe("lost")
	})

	it("fails a confident answer where abstention was expected", () => {
		const graded = gradeAgainstLadder({
			...base,
			expected: { kind: ABSTAIN_RUNG, why: "144 Springfields" },
			lat: 42.1015,
			lon: -72.5898,
		})

		expect(graded.grade).toBe("overconfident")
	})

	it("names a homonym takeover separately from plain overconfidence", () => {
		const graded = gradeAgainstLadder({
			...base,
			expected: { kind: ABSTAIN_RUNG, why: "Paris, France", homonymTakeover: true },
			lat: 48.85,
			lon: 2.35,
		})

		expect(graded.grade).toBe("homonymTakeover")
	})

	it("accepts any rung, and abstention, when the model declined to constrain", () => {
		const unconstrained = { kind: UNCONSTRAINED_RUNG, why: "a venue survived" } as const

		expect(gradeAgainstLadder({ ...base, expected: unconstrained, lat: 39.76, lon: -89.66 }).grade).toBe("degraded")

		expect(gradeAgainstLadder({ ...base, expected: unconstrained, lat: null, lon: null }).grade).toBe(
			"correctlyAbstained"
		)
	})

	// …but declining to constrain is not a blank cheque: leaving the ladder is still wrong.
	it("still fails an off-ladder answer under an unconstrained expectation", () => {
		const graded = gradeAgainstLadder({
			...base,
			expected: { kind: UNCONSTRAINED_RUNG, why: "a venue survived" },
			lat: 48.85,
			lon: 2.35,
		})

		expect(graded.grade).toBe("wrong")
	})

	// S-2 finding 3: the slot came back FILLED with a different token. A good coordinate does not redeem that.
	it("fails a SUBSTITUTION even when the coordinate is perfect", () => {
		const graded = gradeAgainstLadder({
			...base,
			expected: rung(0),
			lat: 39.8017,
			lon: -89.6437,
			slot: "substituted",
		})

		expect(graded.grade).toBe("substituted")
		// The geometry stays readable — the row is a hazard, not a mystery.
		expect(graded.achievedRungDepth).toBe(0)
	})

	it("fails a substitution at a COARSE rung too — the hard fail is at every rung", () => {
		const graded = gradeAgainstLadder({
			...base,
			expected: { kind: UNCONSTRAINED_RUNG, why: "a venue survived" },
			lat: 40,
			lon: -89.2,
			slot: "substituted",
		})

		expect(graded.grade).toBe("substituted")
	})

	describe("the anchor floor — a deletion is charged only for what IT cost", () => {
		it("reads a variant that matches its already-coarse anchor as held, not as a loss", () => {
			// The anchor was already at the locality rung; the variant lands there too. Nothing was lost.
			const graded = gradeAgainstLadder({
				...base,
				anchorRungDepth: 1,
				expected: rung(0),
				lat: 39.8,
				lon: -89.65,
			})

			expect(graded).toMatchObject({ grade: "held", degradedRungs: 0 })
		})

		it("still fails a variant coarser than that anchor", () => {
			const graded = gradeAgainstLadder({ ...base, anchorRungDepth: 1, expected: rung(0), lat: 40, lon: -89.2 })

			// The county rung, one below the locality the anchor already sat on.
			expect(graded).toMatchObject({ grade: "coarser", achievedRungDepth: 2, degradedRungs: 1 })
		})

		it("refuses to grade a row whose undeleted answer is off its own ladder", () => {
			const graded = gradeAgainstLadder({
				...base,
				anchorRungDepth: null,
				expected: rung(0),
				lat: 39.8017,
				lon: -89.6437,
			})

			expect(graded.grade).toBe("ungraded")
		})
	})
})

describe("buildCaseLadder", () => {
	const gz = fakeGazetteer()

	it("anchors on the CORPUS's asserted coordinate, not the pipeline's answer", () => {
		const built = buildCaseLadder({ lat: 42.1015, lon: -72.5898 }, 0.5, gz, { lat: 39.8017, lon: -89.6437 }, "US")

		expect("ladder" in built && built.ladder).toBeTruthy()
		expect((built as { anchorSource: string }).anchorSource).toBe("corpus-expected")
		expect((built as { ladder: AblationLadder }).ladder.rungs[0]).toMatchObject({ lat: 39.8017, lon: -89.6437 })
	})

	it("falls back to the pipeline's answer only when the row asserts no coordinate", () => {
		const built = buildCaseLadder({ lat: 39.8017, lon: -89.6437 }, 0.5, gz, { lat: null, lon: null }, "US")

		expect((built as { anchorSource: string }).anchorSource).toBe("pipeline-anchor")
	})

	// The Bermuda class: the reverse walk starts from `place_bbox`, so a country whose bbox is degenerate is invisible
	// and its points are attributed to a large neighbour. The corpus's own country column is the check.
	it("refuses a ladder whose containment country contradicts the corpus", () => {
		const built = buildCaseLadder({ lat: 32.3, lon: -64.87 }, 1, gz, { lat: 32.3, lon: -64.87 }, "BM")

		expect(built.ladder).toBeNull()
		expect((built as { reason: string }).reason).toContain("INCOHERENT")
	})

	it("refuses a ladder when nothing contains the point", () => {
		const built = buildCaseLadder({ lat: 0, lon: 0 }, 1, fakeGazetteer({ containingChain: () => [] }), undefined, "US")

		expect(built.ladder).toBeNull()
		expect((built as { reason: string }).reason).toContain("no gazetteer place contains")
	})
})

describe("per-case overrides", () => {
	it("pins a rung by placetype", () => {
		expect(overrideToExpectedRung("region", LADDER)).toMatchObject({ kind: "rung", depth: 3 })
	})

	it("pins abstention", () => {
		expect(overrideToExpectedRung(ABSTAIN_RUNG, LADDER)).toMatchObject({ kind: ABSTAIN_RUNG })
	})

	// A pin that cannot be honoured must not silently become the derived answer wearing the pin's name.
	it("returns null for a rung this ladder does not have", () => {
		expect(overrideToExpectedRung("macroregion", LADDER)).toBeNull()
	})

	it("is preferred over the derivation, and says so", () => {
		const described = expectFor({
			ladder: LADDER,
			components: { locality: "Springfield", region: "Illinois" },
			deleted: "region",
			pin: ABSTAIN_RUNG,
			gz: fakeGazetteer(),
			ablatedInput: "742 Evergreen Terrace, Springfield",
		})

		expect(described.source).toBe("override")
		expect(described.rungName).toBe(ABSTAIN_RUNG)
	})

	it("falls back to the derivation — LOUDLY — when the pin names no rung", () => {
		const described = expectFor({
			ladder: LADDER,
			components: { locality: "Springfield", region: "Illinois" },
			deleted: "country",
			pin: "macroregion",
			gz: fakeGazetteer(),
			ablatedInput: "Springfield, Illinois",
		})

		expect(described.source).toBe("derived")
		expect(described.why).toContain("names no rung on this ladder — ignored")
	})

	it("marks a row with no ladder as absent rather than as any kind of pass", () => {
		const described = expectFor({
			ladder: null,
			components: { locality: "Springfield" },
			deleted: "region",
			pin: undefined,
			gz: fakeGazetteer(),
			ablatedInput: "Springfield",
		})

		expect(described.source).toBe("no-ladder")
		expect(described.expected).toBeNull()
	})
})
