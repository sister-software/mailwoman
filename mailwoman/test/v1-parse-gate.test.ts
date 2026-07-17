/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The v7 rules-excision swap gate (Track V1) — RE-GATED 2026-07-17.
 *
 *   ## What changed and why
 *
 *   The original Plan-2 gate asserted **parse-tag byte-parity floors** on the rescued parity corpus:
 *   street ≥ 0.90, house_number ≥ 0.97, postcode ≥ 0.97 (folded string equality of each label's value
 *   against the rules-parser golden). Street sat at ~0.54–0.60 and never cleared 0.90, so the built
 *   T1/T2/T4 neural swaps (`hold/v1-parse-neural-gate-blocked`) were parked indefinitely.
 *
 *   **Operator decision, 2026-07-17** (`scratchpad/MAILWOMAN_ROAD_TO_V7.md` §4.1): the v7 acceptance
 *   criterion is now **coordinate acceptability + the plausibility guard**, NOT the 0.90 parse-tag
 *   street floor. The floor measured the wrong thing for a geocoder — the deepparse head-to-head
 *   proved both parsers sit at ~65% street on hostile input yet resolution is where mailwoman wins —
 *   and 0.90 parse-tag street is plausibly unreachable at 29M params on this fragment-heavy
 *   distribution (`docs/articles/evals/2026-07-15-v7-parity-floor-diagnosis.md`). What matters for the
 *   swap is whether the neural parse **resolves to the same place** as the rules parse it replaces,
 *   and whether the garbage-geocode tail is bounded.
 *
 *   ## The instrument (already built, already measured)
 *
 *   `resolver/plausibility.ts` (`finestResolvedCoordinate` + `isImplausibleResolution`) is the cheap
 *   post-resolve guard: it trips when the neural resolution is only a bare `country` centroid —
 *   implausible for a structured address. The 2026-07-15 coordinate-parity study
 *   (`scratchpad/coord-parity.mjs`, diagnosis doc above) established, over the 321 live parity
 *   fixtures resolved through the same WOF resolver with both the neural and rules trees:
 *
 *     - **Coordinate acceptability** — when the neural street parse is correct, the geocode is
 *       coordinate-safe: 98.6% within 1 km of the rules geocode, median 0 km.
 *     - **A bounded garbage tail** — 18 fixtures diverge > 25 km. The stage-2.5 kind-classifier routes
 *       11 (non-structured kinds) away from the neural parser; of the 7 that classify as
 *       `structured_address`, the plausibility guard catches 4, leaving a residual of **3 of 321
 *       (0.9%)** — the #727 in-country boundary class that stage-2 (k-best span decode) then erases.
 *       The doc frames this as an order-of-magnitude result: "the tail is bounded to low single
 *       digits, not that it is exactly three."
 *     - **Zero false fallbacks** — none of the 81 coordinate-safe structured fixtures trip the guard.
 *
 *   ## What this test asserts (each threshold traces to a measured receipt)
 *
 *   Re-measured here on the CURRENT shipped model (v381 / v6.5.0) with the shipped instrument
 *   (`isImplausibleResolution`, i.e. the country-centroid guard). The three gated properties, and the
 *   fresh measurement each cleared at the time of re-gating:
 *
 *     1. **Coordinate acceptability** — of the both-resolved fixtures whose neural street parse
 *        passes, ≥ 0.90 resolve within 1 km of the rules geocode. Receipt: 98.6%; fresh: 76/80 = 0.950.
 *        Floor set conservatively below both, with noise margin.
 *     2. **Guard soundness (zero false fallbacks)** — no coordinate-safe (Δ ≤ 5 km) `structured_address`
 *        fixture trips the guard. Receipt: 0/81; fresh: 0/78. Hard zero.
 *     3. **Tail bound** — the garbage-tail residual (structured, street-fail, Δ > 25 km, kind-router
 *        miss, guard miss) ≤ 2% of live fixtures. Receipt (guard A+B): 3/321 = 0.9%; fresh (shipped
 *        guard A only): 5/321 = 1.56%. Bound traces to the "low single digits" framing with margin.
 *
 *   The old parse-tag street/hn/postcode agreement is still COMPUTED and logged as an INFORMATIONAL
 *   line (it drives Track B), it just no longer gates the release.
 *
 *   This gate compares the neural resolution against the rules baseline it replaces — the final
 *   pre-excision safety check.
 *
 *   ## Plan-4 conversion (2026-07-17) — the rules arm now reads FROZEN goldens
 *
 *   The v1 rules parser has been DELETED (`createAddressParser` and its module graph are gone). The
 *   rules baseline this gate compares against is no longer produced live; it is read from the
 *   phase-0 frozen capture `mailwoman/test-fixtures/legacy-golden/parity-raw.jsonl` (the top
 *   solution's `classifications` per input, captured byte-stable in PR #1092). That flat record is
 *   rebuilt into an `AddressTree` via `v0RecordToTree` — the SAME synthetic-token builder the live
 *   arm used on `solutions[0].classifications` — and resolved through the WOF resolver exactly as
 *   before. The coordinate comparison is therefore identical to the live arm; only the source of the
 *   rules parse changed (live parser → committed snapshot of that same parser).
 *
 *   Skips when the neural weights or the WOF gazetteer are absent (CI).
 */

import { existsSync, readFileSync, realpathSync } from "node:fs"

import type { AddressTree } from "@mailwoman/core/decoder"
import { dataRootPath } from "@mailwoman/core/utils"
import { classifyKindSync } from "@mailwoman/kind-classifier"
import { NeuralAddressClassifier } from "@mailwoman/neural"
import { normalize } from "@mailwoman/normalize"
import { computeQueryShape } from "@mailwoman/query-shape"
import { createWOFResolver, finestResolvedCoordinate, isImplausibleResolution } from "@mailwoman/resolver"
import { WOFSqlitePlaceLookup } from "@mailwoman/resolver-wof-sqlite"
import { haversineKm } from "@mailwoman/spatial"
import { describe, expect, test } from "vitest"

import { v0RecordToTree } from "../eval-harness/v0-tree-adapter.ts"

/** The frozen rules-parser capture (phase 0, PR #1092): one row per parity input, top-3 solved solutions. */
const PARITY_RAW_GOLDEN = "mailwoman/test-fixtures/legacy-golden/parity-raw.jsonl"

/** A captured rules solution's flat classification record (the shape `solutions[0].classifications` had). */
type RulesRecord = Partial<Record<string, string[]>>

/**
 * Load the frozen rules baseline: `input → the top solution's classifications`. This replaces the deleted live
 * `createAddressParser().parse(...)` call — the record is a byte-stable snapshot of that exact parser (PR #1092).
 */
function loadRulesGolden(): Map<string, RulesRecord> {
	const byInput = new Map<string, RulesRecord>()

	for (const line of readFileSync(PARITY_RAW_GOLDEN, "utf8").split("\n")) {
		if (!line) continue
		const row = JSON.parse(line) as { input: string; solutions?: Array<{ classifications?: RulesRecord }> }
		byInput.set(row.input, row.solutions?.[0]?.classifications ?? {})
	}

	return byInput
}

/** A live parity fixture: input + the per-label rules-golden expectation. */
interface ParityFixture {
	id: string
	input: string
	country?: string
	dropped?: boolean
	expect?: Partial<Record<string, string[]>>
}

/** The street family assembles into one span for parse-tag agreement (matches `scratchpad/coord-parity.mjs`). */
const STREET_TAGS = ["street_prefix", "street", "street_prefix_particle", "street_suffix"]

/** WOF shards the receipt harness resolved against (`admin-global-priority.db` + `postcode-locality-intl.db`). */
const ADMIN_DB = dataRootPath("wof", "admin-global-priority.db")
const POSTCODE_DB = dataRootPath("wof", "postcode-locality-intl.db")

const fold = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim()

function weightsPresent(): boolean {
	try {
		return existsSync(realpathSync("neural-weights-en-us/model.onnx"))
	} catch {
		return false
	}
}

const gazetteerPresent = () => existsSync(ADMIN_DB) && existsSync(POSTCODE_DB)

/** Flatten a tree to its node list, depth-first. */
function flatten(tree: AddressTree): AddressTree["roots"] {
	const out: AddressTree["roots"] = []
	const stack = [...tree.roots]

	while (stack.length) {
		const n = stack.pop()!
		out.push(n)
		stack.push(...n.children)
	}

	return out
}

/** Assemble the folded value of `tags` from a parsed tree, in document order. */
function labelValue(tree: AddressTree, tags: readonly string[]): string {
	return fold(
		flatten(tree)
			.filter((n) => tags.includes(n.tag))
			.sort((a, b) => a.start - b.start)
			.map((n) => n.value)
			.join(" ")
	)
}

function kindOf(input: string): string {
	try {
		const norm = normalize(input)

		return classifyKindSync(norm, computeQueryShape(norm)).kind
	} catch {
		return "error"
	}
}

interface Measured {
	hasStreet: boolean
	streetFail: boolean
	kind: string
	both: boolean
	delta: number | null
	implausible: boolean
	/** Per-label parse-tag agreement (informational): true/false when the fixture carries that label. */
	agree: Partial<Record<string, boolean>>
}

describe.skipIf(!weightsPresent() || !gazetteerPresent())(
	"v7 swap gate — coordinate acceptability + plausibility",
	() => {
		test("neural resolution is coordinate-safe and the garbage tail is bounded by the plausibility guard", async () => {
			const rulesGolden = loadRulesGolden()
			const neural = await NeuralAddressClassifier.loadFromWeights({ locale: "en-US" })
			const backend = new WOFSqlitePlaceLookup({ databasePath: [ADMIN_DB, POSTCODE_DB] })
			const resolver = createWOFResolver(backend)

			const fixtures = readFileSync("mailwoman/eval-harness/fixtures/parity-corpus.triaged.jsonl", "utf8")
				.split("\n")
				.filter(Boolean)
				.map((l) => JSON.parse(l) as ParityFixture)
				.filter((f) => !f.dropped && f.expect)

			const rows: Measured[] = []

			for (const fx of fixtures) {
				const expect_ = fx.expect!
				const opts = { defaultCountry: fx.country || undefined }
				let neuralCoord: ReturnType<typeof finestResolvedCoordinate> = null
				let rulesCoord: ReturnType<typeof finestResolvedCoordinate> = null
				let implausible = false
				const agree: Partial<Record<string, boolean>> = {}

				try {
					const nTree = await neural.parse(fx.input, { postcodeRepair: true })
					const resolved = await resolver.resolveTree(nTree, opts)
					neuralCoord = finestResolvedCoordinate(resolved)
					// Guard A (country-centroid) + guard B (cross-country bbox, folded into the shipped module
					// 2026-07-17 from the receipt harness — the fixture's gold country is the expectedCountry).
					implausible = isImplausibleResolution(resolved, { expectedCountry: fx.country || undefined }).implausible

					for (const [label, tags] of [
						["street", STREET_TAGS],
						["house_number", ["house_number"]],
						["postcode", ["postcode"]],
					] as const) {
						const gold = expect_[label]

						if (gold?.length) {
							agree[label] = labelValue(nTree, tags) === fold(gold.join(" "))
						}
					}
				} catch {
					/* neural parse/resolve failed — leaves neuralCoord null, counts as unresolved */
				}

				try {
					// The rules parse is read from the frozen phase-0 capture (PR #1092), not produced live —
					// the v1 parser is deleted. `v0RecordToTree` rebuilds the flat record into a tree exactly as
					// the live arm did, so the coordinate comparison is unchanged.
					const record = rulesGolden.get(fx.input) ?? {}
					const tree = v0RecordToTree(fx.input, record).tree
					rulesCoord = finestResolvedCoordinate(await resolver.resolveTree(tree, opts))
				} catch {
					/* rules rebuild/resolve failed — leaves rulesCoord null */
				}

				const both = !!neuralCoord && !!rulesCoord
				rows.push({
					hasStreet: !!expect_.street,
					streetFail: expect_.street ? agree.street === false : false,
					kind: kindOf(fx.input),
					both,
					delta: both ? haversineKm(rulesCoord!.lat, rulesCoord!.lon, neuralCoord!.lat, neuralCoord!.lon) : null,
					implausible,
					agree,
				})
			}

			// ---- INFORMATIONAL: the old parse-tag agreement (non-gating; drives Track B) ----
			const agreement = (label: string) => {
				const scored = rows.filter((r) => r.agree[label] !== undefined)
				const hit = scored.filter((r) => r.agree[label]).length

				return { hit, total: scored.length, rate: scored.length ? hit / scored.length : 1 }
			}

			for (const label of ["street", "house_number", "postcode"]) {
				const a = agreement(label)
				console.error(`[informational] parse-tag ${label}: ${a.hit}/${a.total} = ${a.rate.toFixed(4)} (non-gating)`)
			}

			// ---- P1. Coordinate acceptability ----
			const both = rows.filter((r) => r.both)
			const streetPass = both.filter((r) => r.hasStreet && !r.streetFail)
			const streetPassWithin1km = streetPass.filter((r) => r.delta! <= 1).length
			const acceptRate = streetPass.length ? streetPassWithin1km / streetPass.length : 1

			// ---- P2. Guard false positives on the coordinate-safe structured set ----
			const safeStructured = both.filter((r) => r.delta! <= 5 && r.kind === "structured_address")
			const guardFalsePositives = safeStructured.filter((r) => r.implausible).length

			// ---- P3. Garbage-tail residual after kind-router + plausibility guard ----
			const tail = both.filter((r) => r.hasStreet && r.streetFail && r.delta! > 25)
			const tailStructured = tail.filter((r) => r.kind === "structured_address")
			const residual = tailStructured.filter((r) => !r.implausible).length
			const residualRate = residual / rows.length

			console.error(`[gate] live fixtures: ${rows.length}  both-resolved: ${both.length}`)
			console.error(
				`[gate] P1 coordinate acceptability (street-PASS within 1km): ${streetPassWithin1km}/${streetPass.length} = ${acceptRate.toFixed(4)} (floor 0.90; receipt 0.986)`
			)
			console.error(
				`[gate] P2 guard false positives (coord-safe structured tripping guard): ${guardFalsePositives}/${safeStructured.length} (bound 0; receipt 0/81)`
			)
			console.error(
				`[gate] P3 garbage-tail residual (structured, street-fail, Δ>25km, guard-miss): ${residual}/${rows.length} = ${(100 * residualRate).toFixed(2)}% (bound 2.0%; receipt 0.9% = 3/321)`
			)

			// P1 — Receipt: 98.6% within 1km when the neural street parse is correct; fresh: 76/80 = 0.950.
			//      Floor 0.90 sits below both with margin. When the model parses the street right, the geocode is safe.
			expect(
				acceptRate,
				"coordinate acceptability: street-PASS neural geocode within 1km of rules"
			).toBeGreaterThanOrEqual(0.9)

			// P2 — Receipt: 0/81 coord-safe structured fixtures trip the guard; fresh: 0/78. Zero false fallbacks is
			//      the guard's whole justification — a non-zero here means it would bounce good geocodes to fallback.
			expect(guardFalsePositives, "plausibility-guard false fallbacks on coord-safe structured fixtures").toBe(0)

			// P3 — Receipt (guard A+B): 3/321 = 0.9%; fresh (shipped guard A / country-centroid only): 5/321 = 1.56%.
			//      The diagnosis frames the residual as an order-of-magnitude "low single digits"; 2% bounds it with
			//      one fixture of noise margin over the fresh measurement. Stage-2 (#727 k-best) shrinks it further.
			expect(residualRate, "garbage-tail residual after kind-router + plausibility guard").toBeLessThanOrEqual(0.02)
		}, 600_000)
	}
)
