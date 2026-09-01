/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests for the Gauntlet ABLATION layer at fixture scale. Everything here is pure — variant generation, slot
 *   classification, cell aggregation, rendering — because the layer's own run needs the ~9 GB database set and a loaded
 *   ONNX, and because every one of these three has a silent failure mode:
 *
 *   - a deletion that carves a span out of its NEIGHBOUR still produces a number, and the number looks like evidence
 *       about the component named in the row;
 *   - a slot refilled by a different token looks identical to an empty slot unless something compares the values;
 *   - a (component, locale) pair nobody measured renders as `0` unless the renderer is told that zero support is
 *       ABSENCE. That last one is the house's meaning-of-zero rule and the only rule here a reader of the
 *       finished table can be misled by.
 */

import {
	ABLATABLE_COMPONENTS,
	ABLATION_ABSENT,
	ablationBoardID,
	ablationVariants,
	type AblationRowOutcome,
	aggregateCells,
	boundedOccurrences,
	classifySlot,
	deleteSpan,
	formatAblationCell,
	isTierDrop,
	renderAblationMarkdown,
	scoreAblation,
} from "mailwoman/eval-harness/gauntlet/ablation"
import type { GauntletResult } from "mailwoman/eval-harness/gauntlet/harness"
import { runAblationOptions } from "mailwoman/eval-harness/gauntlet/run"
import { describe, expect, it } from "vitest"

/**
 * A minimal assembled result. Only the fields a given assertion reads are overridden.
 */
function result(over: Partial<GauntletResult> = {}): GauntletResult {
	return {
		lat: 40.7484,
		lon: -73.9857,
		tier: "address_point",
		locality: null,
		region: null,
		country: null,
		postcode: null,
		house_number: null,
		street: null,
		venue: null,
		dependent_locality: null,
		unit: null,
		postcode_country_scope: null,
		hierarchy: [],
		components: {},
		...over,
	}
}

describe("boundedOccurrences — the guard that keeps a deletion attributable", () => {
	it("finds a whole-token occurrence", () => {
		expect(boundedOccurrences("181 Rue du Chevaleret, 75013 Paris", "75013")).toEqual([23])
	})

	it("is case-insensitive, because the corpus asserts resolved casing against typed casing", () => {
		expect(boundedOccurrences("350 5th ave, NEW YORK, NY", "New York")).toEqual([13])
	})

	// The input-tail case: `York` is a substring of `New York`, and an indexOf-based stripper would carve it out,
	// leaving "New , NY" and attributing the damage to the locality.
	it("refuses an occurrence glued to a letter on either side", () => {
		expect(boundedOccurrences("350 5th Ave, New York, NY", "York")).toEqual([17])
		expect(boundedOccurrences("Yorkshire Road, Leeds", "York")).toEqual([])
		expect(boundedOccurrences("New Yorkshire, Leeds", "York")).toEqual([])
	})

	it("reports EVERY occurrence, so the caller can refuse an ambiguous one", () => {
		expect(boundedOccurrences("Paris, Paris, France", "Paris")).toHaveLength(2)
	})

	it('returns nothing for an empty value — the `postcode: ""` negative assertion', () => {
		expect(boundedOccurrences("1600 Pennsylvania Ave NW, Washington DC", "")).toEqual([])
	})
})

describe("deleteSpan — the cut, and the separator debris it leaves", () => {
	it("closes the gap a mid-string deletion opens", () => {
		const input = "181 Rue du Chevaleret, 75013 Paris"

		expect(deleteSpan(input, 23, 5)).toBe("181 Rue du Chevaleret, Paris")
	})

	it("strips the orphaned comma a leading deletion leaves", () => {
		expect(deleteSpan("75013, Paris", 0, 5)).toBe("Paris")
	})

	it("strips the orphaned comma a trailing deletion leaves", () => {
		expect(deleteSpan("181 Rue du Chevaleret, Paris, France", 30, 6)).toBe("181 Rue du Chevaleret, Paris")
	})

	it("collapses a doubled comma when a whole middle segment goes", () => {
		expect(deleteSpan("123 Main St, Park Slope, Brooklyn, NY", 13, 10)).toBe("123 Main St, Brooklyn, NY")
	})
})

describe("ablationVariants — one variant per attributable component", () => {
	const components = {
		house_number: "181",
		street: "Rue du Chevaleret",
		postcode: "75013",
		locality: "Paris",
	}

	it("generates one deletion per asserted component present verbatim", () => {
		const { variants } = ablationVariants("181 Rue du Chevaleret, 75013 Paris", components)

		expect(variants.map((v) => v.component).toSorted()).toEqual(["house_number", "locality", "postcode", "street"])
		expect(variants.find((v) => v.component === "postcode")!.input).toBe("181 Rue du Chevaleret, Paris")
		expect(variants.find((v) => v.component === "house_number")!.input).toBe("Rue du Chevaleret, 75013 Paris")
	})

	it("honours a component filter", () => {
		const { variants } = ablationVariants(
			"181 Rue du Chevaleret, 75013 Paris",
			components,
			new Set(["postcode"] as const)
		)

		expect(variants).toHaveLength(1)
		expect(variants[0]!.component).toBe("postcode")
	})

	// `us-dc-pennsylvania` asserts `postcode: ""` to pin that the slot stays EMPTY. Counting that as a deletion
	// would manufacture support for a cell nobody measured.
	it("refuses an empty asserted value rather than counting it as support", () => {
		const { variants, skips } = ablationVariants("1600 Pennsylvania Ave NW, Washington DC", {
			postcode: "",
			region: "DC",
		})

		expect(variants.map((v) => v.component)).toEqual(["region"])
		expect(skips).toContainEqual({ component: "postcode", value: "", reason: "empty" })
	})

	it("refuses a value that is not in the input verbatim", () => {
		const { variants, skips } = ablationVariants("350 5th Ave, New York, NY", {
			country: "United States",
			region: "NY",
		})

		expect(variants.map((v) => v.component)).toEqual(["region"])
		expect(skips[0]).toMatchObject({ component: "country", reason: "not-verbatim" })
	})

	it("refuses an ambiguous value — two boundary-safe occurrences", () => {
		const { variants, skips } = ablationVariants("Paris, Paris", { locality: "Paris" })

		expect(variants).toHaveLength(0)
		expect(skips[0]!.reason).toBe("ambiguous: 2 occurrences")
	})

	it("refuses a value asserted for two components at once", () => {
		const { variants, skips } = ablationVariants("Brooklyn, NY", { locality: "Brooklyn", venue: "Brooklyn" })

		expect(variants).toHaveLength(0)

		expect(skips.map((s) => s.reason)).toEqual([
			"ambiguous: same value asserted for venue",
			"ambiguous: same value asserted for locality",
		])
	})

	// The nesting case, stated as a whole variant rather than as a substring test: deleting `York` out of
	// `New York` would report a two-component deletion under the locality's name.
	it("refuses a value nested inside another asserted component", () => {
		const { variants, skips } = ablationVariants("350 5th Ave, New York, NY", {
			locality: "New York",
			dependent_locality: "York",
		})

		expect(variants.map((v) => v.component)).toEqual(["locality"])
		expect(skips[0]).toMatchObject({ component: "dependent_locality", reason: 'nested inside locality "New York"' })
	})

	it("only ever proposes tags this runner can score a substitution for", () => {
		const { variants } = ablationVariants("Suite 400, 350 5th Ave, New York, NY", {
			unit: "Suite 400",
			locality: "New York",
			subregion: "Manhattan",
		})

		expect(variants.map((v) => v.component).toSorted()).toEqual(["locality", "unit"])

		for (const v of variants) {
			expect(ABLATABLE_COMPONENTS).toContain(v.component)
		}
	})
})

describe("classifySlot — substitution is not the same as absence", () => {
	it("reads an empty slot as absent", () => {
		expect(classifySlot("75013", null)).toBe("absent")
		expect(classifySlot("75013", "")).toBe("absent")
	})

	it("reads the deleted value coming back as a recovery, not a hazard", () => {
		expect(classifySlot("75013", "75013")).toBe("recovered")
	})

	it("ignores separator and case differences when deciding recovery", () => {
		expect(classifySlot("BT3 9QQ", "bt39qq")).toBe("recovered")
	})

	// The S-2 finding-3 class, which is the reason this field exists: the postcode slot came back FILLED, with the
	// house number. A completion nudge reading that slot would abstain for the wrong reason, or confirm it.
	it("reads a different token in the slot as a substitution", () => {
		expect(classifySlot("94043", "1600")).toBe("substituted")
		expect(classifySlot("75005", "1802")).toBe("substituted")
		expect(classifySlot("BT3 9QQ", "W4")).toBe("substituted")
	})
})

describe("scoreAblation — one deletion against its own anchor", () => {
	it("holds when the coordinate stays inside the row's tolerance", () => {
		const scored = scoreAblation(result(), result(), "75013", "postcode", 5)

		expect(scored.displacementKm).toBe(0)
		expect(scored.broken).toBe(false)
		expect(scored.unresolved).toBe(false)
		expect(scored.tierDrop).toBe(false)
	})

	it("breaks when the deletion moves the coordinate past the row's own tolerance", () => {
		// ~1.1 km north of the anchor; inside a 5 km band and outside an 80 m rooftop pin.
		const moved = result({ lat: 40.7584 })

		expect(scoreAblation(result(), moved, "75013", "postcode", 5).broken).toBe(false)
		expect(scoreAblation(result(), moved, "75013", "postcode", 0.08).broken).toBe(true)
	})

	it("counts a lost coordinate as broken, not as a small displacement", () => {
		const scored = scoreAblation(result(), result({ lat: null, lon: null, tier: "admin" }), "75013", "postcode", 5)

		expect(scored.displacementKm).toBeNull()
		expect(scored.broken).toBe(true)
		expect(scored.unresolved).toBe(true)
	})

	// A row whose OWN anchor never resolved measures nothing. Reporting it as held would be the meaning-of-zero
	// trap one level below the renderer.
	it("returns broken=null when the anchor itself never resolved", () => {
		const scored = scoreAblation(result({ lat: null, lon: null }), result(), "75013", "postcode", 5)

		expect(scored.broken).toBeNull()
	})

	it("reads the substituted slot off the SAME field the regression gate grades", () => {
		const scored = scoreAblation(result(), result({ postcode: "1600" }), "94043", "postcode", 5)

		expect(scored.slot).toBe("substituted")
		expect(scored.emitted).toBe("1600")
	})
})

describe("isTierDrop — coarsening costs the user precision even at zero displacement", () => {
	it("reads a walk down the ladder as a drop", () => {
		expect(isTierDrop("address_point", "street")).toBe(true)
		expect(isTierDrop("address_point", "interpolated")).toBe(true)
		expect(isTierDrop("street", "admin")).toBe(true)
	})

	it("reads a same or finer tier as no drop", () => {
		expect(isTierDrop("street", "street")).toBe(false)
		expect(isTierDrop("admin", "address_point")).toBe(false)
	})
})

/**
 * A row outcome with the fields a cell aggregates; the rest is filler the aggregation never reads.
 */
function row(over: Partial<AblationRowOutcome>): AblationRowOutcome {
	return {
		caseID: "case",
		component: "postcode",
		locale: "GB",
		status: "pass",
		deleted: "BT3 9QQ",
		anchorInput: "in",
		ablatedInput: "out",
		anchorLat: 0,
		anchorLon: 0,
		anchorTier: "address_point",
		ablatedLat: 0,
		ablatedLon: 0,
		ablatedTier: "address_point",
		displacementKm: 0,
		toleranceKm: 5,
		broken: false,
		tierDrop: false,
		unresolved: false,
		slot: "absent",
		emitted: null,
		// The expectation-model fields (2026-08-05). A fixture that omitted them would let `aggregateCells` count an
		// `undefined` grade, which is how a histogram silently grows a tenth bucket nobody reads.
		expectedRung: "base",
		expectedRungDepth: 0,
		expectedWhy: "fixture",
		expectedSource: "derived",
		ladderAnchor: "corpus-expected",
		anchorRungDepth: 0,
		achievedRung: "base",
		achievedRungDepth: 0,
		degradedRungs: 0,
		grade: "held",
		ladder: [],
		ladderGaps: [],
		...over,
	}
}

describe("aggregateCells", () => {
	const meta = { boardID: "board", measuredAt: "2026-08-05T00:00:00.000Z" }

	it("keys by (component, locale) and counts each outcome class once", () => {
		const cells = aggregateCells(
			[
				row({ caseID: "a", broken: true, displacementKm: 12, tierDrop: true }),
				row({ caseID: "b", broken: false, displacementKm: 0.2, slot: "substituted", emitted: "1600" }),
				row({ caseID: "c", broken: true, displacementKm: null, unresolved: true }),
				row({ caseID: "d", broken: null, displacementKm: null }),
				row({ caseID: "e", locale: "FR", displacementKm: 1, slot: "recovered" }),
			],
			meta
		)

		expect(cells).toHaveLength(2)

		const gb = cells.find((c) => c.locale === "GB")!

		expect(gb.support).toBe(4)
		expect(gb.brokenCount).toBe(2)
		expect(gb.unresolvedCount).toBe(1)
		expect(gb.tierDropCount).toBe(1)
		expect(gb.substitutedCount).toBe(1)
		expect(gb.anchorUnresolvedCount).toBe(1)
		expect(gb.gradedCount).toBe(2)
		expect(gb.displacementKmP90).toBe(12)

		const fr = cells.find((c) => c.locale === "FR")!

		expect(fr.support).toBe(1)
		expect(fr.recoveredCount).toBe(1)
	})

	it("stamps every cell with the board and the time — a cell without both is not a measurement", () => {
		for (const cell of aggregateCells([row({})], meta)) {
			expect(cell.boardID).toBe("board")
			expect(cell.measuredAt).toBe("2026-08-05T00:00:00.000Z")
		}
	})

	// The absence rule, enforced at the SOURCE as well as at the renderer: an unmeasured pair must not exist as a
	// zero-support cell that a consumer could average into a ranking.
	it("emits no cell at all for a (component, locale) pair with no rows", () => {
		const cells = aggregateCells([row({ component: "postcode", locale: "GB" })], meta)

		expect(cells.some((c) => c.component === "street")).toBe(false)
		expect(cells.every((c) => c.support > 0)).toBe(true)
	})
})

describe("the support-0-is-absence rendering rule", () => {
	const meta = { boardID: "board", measuredAt: "2026-08-05T00:00:00.000Z" }

	it("renders a missing cell as absence, never as a zero", () => {
		expect(formatAblationCell(undefined)).toBe(ABLATION_ABSENT)
		expect(formatAblationCell(undefined)).not.toBe("0")
		expect(formatAblationCell(undefined)).not.toContain("0")
	})

	it("renders an explicitly zero-support cell the same way", () => {
		const [cell] = aggregateCells([row({})], meta)

		expect(formatAblationCell({ ...cell!, support: 0 })).toBe(ABLATION_ABSENT)
	})

	it("renders a measured cell as broken/support — including a genuine zero BROKEN count", () => {
		const [cell] = aggregateCells([row({ broken: false }), row({ caseID: "b", broken: false })], meta)

		// This is the distinction the rule protects: 0 of 2 broken is a MEASUREMENT that the component did not
		// matter here, and it must not read like the unmeasured cell above.
		expect(formatAblationCell(cell)).toBe("0/2")
		expect(formatAblationCell(cell)).not.toBe(ABLATION_ABSENT)
	})

	it("puts the absence marker in the matrix and says what it means", () => {
		const cells = aggregateCells([row({ component: "postcode", locale: "GB" })], meta)

		const md = renderAblationMarkdown(cells, [], {
			...meta,
			caseCount: 1,
			variantCount: 1,
			skips: [],
			levers: "resolver levers: (none pinned — production defaults)",
			minLocaleRows: 1,
		})

		expect(md).toContain("| postcode | 0/1 |")
		expect(md).toContain(`\`${ABLATION_ABSENT}\` means NOT MEASURED`)
	})

	// The tail threshold folds thin locales into a list. Folding is only acceptable because they are PRINTED —
	// and a zero-column matrix must say why it is empty rather than emit a headerless table.
	it("says so when no locale cleared the matrix threshold, instead of rendering an empty table", () => {
		const md = renderAblationMarkdown(aggregateCells([row({})], meta), [], {
			...meta,
			caseCount: 1,
			variantCount: 1,
			skips: [],
			levers: "x",
		})

		expect(md).toContain("No locale carries 3 or more measured rows")
		expect(md).toContain("- **GB** — postcode 0/1")
	})

	it("renders an unmeasured locale column as absence in every component row", () => {
		const cells = aggregateCells(
			[
				row({ component: "postcode", locale: "GB" }),
				row({ component: "postcode", locale: "FR" }),
				row({ component: "street", locale: "GB" }),
			],
			meta
		)

		const md = renderAblationMarkdown(cells, [], {
			...meta,
			caseCount: 3,
			variantCount: 3,
			skips: [],
			levers: "x",
			minLocaleRows: 1,
		})

		// street was measured in GB and NOT in FR: the FR column must be the absence marker, not 0/0.
		expect(md).toContain(`| street | 0/1 | ${ABLATION_ABSENT} |`)
		expect(md).not.toContain("0/0")
	})
})

describe("ablationBoardID — a cell without a board is not a measurement", () => {
	it("is stable across row order", () => {
		const a = [
			{ id: "a", input: "1" },
			{ id: "b", input: "2" },
		]

		expect(ablationBoardID(a)).toBe(ablationBoardID([...a].toReversed()))
	})

	it("changes when a row's INPUT changes, so a stale map cannot be compared against a fresh one", () => {
		expect(ablationBoardID([{ id: "a", input: "1" }])).not.toBe(ablationBoardID([{ id: "a", input: "1 edited" }]))
	})

	it("carries the row count in plain sight", () => {
		expect(ablationBoardID([{ id: "a", input: "1" }])).toMatch(/^gauntlet-regression@1:[\da-f]{12}$/)
	})
})

/**
 * The CLI → layer plumbing, pinned for the reason `lever-pin.test.ts` pins the resolver pin: a dropped option does not
 * throw. A dropped `--components` runs the WHOLE corpus and prints a map that looks exactly like the one asked for; a
 * dropped `--limit` turns a smoke run into a forty-minute one.
 */
describe("runAblationOptions — a CLI flag reaches the layer", () => {
	it("carries the three ablation options alongside the shared model/lever ladder", () => {
		const options = runAblationOptions({
			candidate: "./out/v9/model.onnx",
			postcodeCountryCoherence: false,
			out: "/tmp/map",
			components: ["postcode", "street"],
			limit: 12,
		})

		expect(options.model).toBe("./out/v9/model.onnx")
		expect(options.levers).toEqual({ postcodeCountryCoherence: false })
		expect(options.outDir).toBe("/tmp/map")
		expect(options.components).toEqual(["postcode", "street"])
		expect(options.limit).toBe(12)
	})

	// Absent must stay absent: an `outDir: undefined` own property would defeat the `??` default, and an empty
	// `components` array would filter every tag out and measure nothing.
	it("omits each option entirely when its flag was never set", () => {
		const options = runAblationOptions({})

		expect("outDir" in options).toBe(false)
		expect("components" in options).toBe(false)
		expect("limit" in options).toBe(false)
	})

	it("treats an empty component list as unset rather than as a filter matching nothing", () => {
		expect("components" in runAblationOptions({ components: [] })).toBe(false)
	})
})
