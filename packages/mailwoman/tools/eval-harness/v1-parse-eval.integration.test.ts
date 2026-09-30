/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The v7 rules-excision swap check. The acceptance criterion is coordinate acceptability plus
 *   the plausibility guard, so the check asks whether the neural parse resolves to the same place
 *   as the rules parse it replaces and whether the garbage-geocode tail is bounded.
 *
 *   The v1 rules parser has been deleted, so the rules baseline is read from the phase-0 frozen
 *   capture in `legacy-golden/parity-raw.jsonl` and rebuilt into an `AddressTree` with
 *   `v0RecordToTree`. The coordinate comparison is identical to the live arm. Only the source
 *   of the rules parse changed.
 *
 *   Skips when the neural weights or the WOF gazetteer are absent (CI).
 */

import { walkNodes, type AddressTree } from "@mailwoman/core/decoder"
import { pathExists } from "@mailwoman/core/fs/readers"
import { classifyKindSync } from "@mailwoman/kind-classifier"
import { NeuralAddressClassifier } from "@mailwoman/neural"
import { resolveWeights } from "@mailwoman/neural/weights"
import { normalize } from "@mailwoman/normalize"
import { computeQueryShape } from "@mailwoman/query-shape"
import { createWOFResolver, finestResolvedCoordinate, isImplausibleResolution } from "@mailwoman/resolver"
import { WOFSQLitePlaceLookup } from "@mailwoman/resolver-wof-sqlite"
import { wofDatabasePath } from "@mailwoman/resolver-wof-sqlite/paths"
import { haversineKm } from "@mailwoman/spatial"
import { resolvePath } from "path-ts"
import { JSONSpliterator } from "spliterator"
import { describe, expect, test } from "vitest"

import { v0RecordToTree } from "#tools/eval-harness/v0-tree-adapter"

/**
 * The frozen rules-parser capture, one row per parity input with the top three solved solutions.
 */
const PARITY_RAW_GOLDEN = "packages/mailwoman/lib/test-fixtures/legacy-golden/parity-raw.jsonl"

/**
 * A captured rules solution's flat classification record (the shape `solutions[0].classifications` had).
 */
type RulesRecord = Partial<Record<string, string[]>>

/**
 * Load the frozen rules baseline, mapping `input` to the top solution's classifications.
 */
async function loadRulesGolden(): Promise<Map<string, RulesRecord>> {
	const byInput = new Map<string, RulesRecord>()

	for await (const row of JSONSpliterator.fromAsync<{
		input: string
		solutions?: Array<{ classifications?: RulesRecord }>
	}>(PARITY_RAW_GOLDEN)) {
		byInput.set(row.input, row.solutions?.[0]?.classifications ?? {})
	}

	return byInput
}

/**
 * A live parity fixture: input + the per-label rules-golden expectation.
 */
interface ParityFixture {
	id: string
	input: string
	country?: string
	dropped?: boolean
	expect?: Partial<Record<string, string[]>>
}

/**
 * The street family assembles into one span for parse-tag agreement.
 */
const STREET_TAGS = ["street_prefix", "street", "street_prefix_particle", "street_suffix"]

/**
 * WOF databases the parity fixtures resolve against.
 */
const ADMIN_DB = wofDatabasePath("admin-global-priority.db")
const POSTCODE_DB = wofDatabasePath("postcode-locality-intl.db")

const fold = (s: string) => s.toLowerCase().replaceAll(/\s+/g, " ").trim()

async function weightsPresent(): Promise<boolean> {
	try {
		// Ask the resolver rather than probing a package path literal directly.
		// A skip guard that stops matching does not fail, it skips, so the suite
		// disappears from the run while the run reports success.
		return await pathExists((await resolveWeights({ locale: "en-us" })).modelPath)
	} catch {
		return false
	}
}

const gazetteerPresent = async () => (await pathExists(ADMIN_DB)) && (await pathExists(POSTCODE_DB))

/**
 * Assemble the folded value of `tags` from a parsed tree, in document order.
 */
function labelValue(tree: AddressTree, tags: readonly string[]): string {
	return fold(
		[...walkNodes(tree.roots)]
			.filter((n) => tags.includes(n.tag))
			.toSorted((a, b) => a.start - b.start)
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
	/**
	 * Per-label parse-tag agreement (informational): true/false when the fixture includes that label.
	 */
	agree: Partial<Record<string, boolean>>
}

describe.skipIf(!(await weightsPresent()) || !(await gazetteerPresent()))(
	"v7 swap check — coordinate acceptability + plausibility",
	() => {
		test("neural resolution is coordinate-safe and the garbage tail is bounded by the plausibility guard", async () => {
			const rulesGolden = await loadRulesGolden()
			const neural = await NeuralAddressClassifier.loadFromWeights({ locale: "en-US" })
			using backend = new WOFSQLitePlaceLookup({ databasePath: [resolvePath(ADMIN_DB), resolvePath(POSTCODE_DB)] })
			const resolver = createWOFResolver(backend)

			const fixtures = await JSONSpliterator.fromAsync<ParityFixture>(
				"packages/mailwoman/tools/eval-harness/fixtures/parity-corpus.triaged.jsonl"
			)
				.filter((f) => !f.dropped && f.expect)
				.toArray()

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
					// Guard A (country-centroid) plus guard B (cross-country bbox).
					// The fixture's gold country is the expectedCountry.
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
					/* A failed neural parse or resolve leaves neuralCoord null and counts as unresolved. */
				}

				try {
					// The rules parse is read from the frozen phase-0 capture and rebuilt with
					// `v0RecordToTree` exactly as the live arm did, so the coordinate comparison is unchanged.
					const record = rulesGolden.get(fx.input) ?? {}
					const tree = v0RecordToTree(fx.input, record).tree
					rulesCoord = finestResolvedCoordinate(await resolver.resolveTree(tree, opts))
				} catch {
					/* A failed rules rebuild or resolve leaves rulesCoord null. */
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

			// The parse-tag agreement is informational and drives Track B.
			const agreement = (label: string) => {
				const scored = rows.filter((r) => r.agree[label] !== undefined)
				const hit = scored.filter((r) => r.agree[label]).length

				return { hit, total: scored.length, rate: scored.length ? hit / scored.length : 1 }
			}

			for (const label of ["street", "house_number", "postcode"]) {
				const a = agreement(label)

				console.error(`[informational] parse-tag ${label}: ${a.hit}/${a.total} = ${a.rate.toFixed(4)} (non-enforcing)`)
			}

			// P1 coordinate acceptability.
			const both = rows.filter((r) => r.both)
			const streetPass = both.filter((r) => r.hasStreet && !r.streetFail)
			const streetPassWithin1km = streetPass.filter((r) => r.delta! <= 1).length
			const acceptRate = streetPass.length ? streetPassWithin1km / streetPass.length : 1

			// P2 guard false positives on the coordinate-safe structured set.
			const safeStructured = both.filter((r) => r.delta! <= 5 && r.kind === "structured_address")
			const guardFalsePositives = safeStructured.filter((r) => r.implausible).length

			// P3 garbage-tail residual after the kind router and the plausibility guard.
			const tail = both.filter((r) => r.hasStreet && r.streetFail && r.delta! > 25)
			const tailStructured = tail.filter((r) => r.kind === "structured_address")
			const residual = tailStructured.filter((r) => !r.implausible).length
			const residualRate = residual / rows.length

			console.error(`[check] live fixtures: ${rows.length}  both-resolved: ${both.length}`)
			console.error(
				`[check] P1 coordinate acceptability (street-PASS within 1km): ${streetPassWithin1km}/${streetPass.length} = ${acceptRate.toFixed(4)} (floor 0.90; receipt 0.986)`
			)
			console.error(
				`[check] P2 guard false positives (coord-safe structured tripping guard): ${guardFalsePositives}/${safeStructured.length} (bound 0; receipt 0/81)`
			)
			console.error(
				`[check] P3 garbage-tail residual (structured, street-fail, Δ>25km, guard-miss): ${residual}/${rows.length} = ${(100 * residualRate).toFixed(2)}% (bound 2.0%; receipt 0.9% = 3/321)`
			)

			expect(
				acceptRate,
				"coordinate acceptability: street-PASS neural geocode within 1km of rules"
			).toBeGreaterThanOrEqual(0.9)

			expect(guardFalsePositives, "plausibility-guard false fallbacks on coord-safe structured fixtures").toBe(0)

			expect(residualRate, "garbage-tail residual after kind-router + plausibility guard").toBeLessThanOrEqual(0.02)
		}, 600_000)
	}
)
