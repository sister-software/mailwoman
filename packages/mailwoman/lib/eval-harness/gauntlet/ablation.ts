/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Gauntlet ABLATION layer — the required map. For every corpus row that ASSERTS a component, delete
 *   that component from the input and re-run the full pipeline: the displacement from the row's own
 *   undeleted anchor says what the component was worth. Aggregated per (component, locale) it answers the
 *   operator's question directly — "where does the pipeline falter when a part of the address is missing?"
 *   — and hands the suggestion layer its per-(component, locale) prior on nudge value
 *   (`docs/superpowers/plans/2026-08-05-suggestion-layer.md` §C.5, which specifies `AblationCell`).
 *
 *   This is a MEASUREMENT layer, not a gate. It never joins the combined verdict (`run.ts` lists only
 *   regression + metamorphic), it has no stored expected values, and its verdict says only whether the
 *   INSTRUMENT ran — a map of all-zero cells is "not measured", never "nothing broke" (meaning-of-zero).
 *
 *   Three ancestors, generalized rather than duplicated:
 *
 *   - `metamorphic.ts`'s DIR class deletes a `\b\d{5}\b` postcode from 3 hand-listed bases and asserts ≤5 km.
 *       That is one component, one tolerance, seven rows, and a REGEX — which on the 4-digit systems deletes
 *       house numbers. Here the deletion is LITERAL (the asserted span, boundary-checked), every component
 *       the row asserts is deleted in turn, and the tolerance is the row's own.
 *   - `check-case.ts`'s `componentOf` maps an `expect_components` key to the assembled-result field. Reused
 *       verbatim (exported for this), so the slot a deletion is scored against is the same slot the gate grades.
 *   - S-2 (`scripts/diagnostic/suggestion/s2-postcode-free.ts`, the suggestion arc's postcode column) is this
 *       runner's postcode column, and its finding 3 is why `substitutedCount` exists: 16 of 139 postcode
 *       deletions did not yield "no postcode", they yielded a DIFFERENT token in the postcode slot (house
 *       numbers, a venue's year, a plus code) and 0 of 139 recovered the deleted code.
 *
 *   LINK EVERY OVERLAY BEFORE YOU BELIEVE A NUMBER HERE. The first full run (2026-08-05, 177 cases → 667 variants)
 *   reproduced S-2's postcode column EXACTLY in FR, US, IE, MX and ES — and differed on 13 of 47 GB rows, because the
 *   worktree S-2 ran in carried no `neural-weights-en-gb` artifacts and graded GB base-only. With the overlay linked,
 *   GB postcode-free goes 48.9% → 55.3% within 5 km, 42.6% → 36.2% beyond 100 km, p50 5.70 → 1.97 km. Five locales
 *   agreeing to the digit is what makes the sixth's disagreement attributable; run
 *   `node neural-weights-<locale>/scripts/link-dev-weights.ts` for every overlay first, or the map measures the
 *   instrument.
 *
 *   ## The grading is NORMATIVE since 2026-08-05 — see `ablation-expectation.ts`
 *
 *   The first version graded every deletion variant against the UNDELETED case's single anchor and single tolerance,
 *   which reports "confidently wrong" and "correctly degraded to the next-best answer" as the same red cell. It now
 *   grades against a GRACEFUL-DEGRADATION LADDER synthesized per row from the gazetteer — the row's own asserted
 *   coordinate, then the admin chain CONTAINING it, each rung with a centroid and a radius — and the expected rung is
 *   computed from the components the deletion LEFT BEHIND, never from the variant's own output, which would be
 *   circular.
 *
 *   Three outcomes are PASSES: the answer held at the base rung, it coarsened to a rung the surviving evidence still
 *   justifies, or it ABSTAINED where the surviving evidence justifies nothing (bare `Springfield`: 144 distinct places,
 *   no population winner). Substitution stays a hard fail at every rung — a coordinate cannot redeem a slot refilled by
 *   the wrong token.
 *
 *   The pre-2026-08-05 fields (`brokenCount`, `unresolvedCount`, `displacementKm*`) are UNCHANGED and still computed
 *   against the anchor: the two gradings sit side by side in every artifact, which is what makes the regrade
 *   comparable. `unresolvedCount` is not split in place; `correctlyAbstainedCount` and `lostCount` are the split, added
 *   alongside it (meaning-of-zero: an abstention asks the operator for nothing, a loss asks for a recall fix).
 *
 *   Run: mailwoman eval gauntlet --layer ablation [--components postcode,street] [--limit 20] [--out DIR]
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { makeDirectories, writeLocalFile, writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { tryParsingJSON } from "@mailwoman/core/objects"
import { percentile, sha256Hex } from "@mailwoman/core/utils"
import { haversineKm } from "@mailwoman/spatial"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { join } from "path-ts"

import {
	ABLATION_ABSENT,
	type AblationGrade,
	achievedRung,
	buildCaseLadder,
	describeLadder,
	emptyGrades,
	expectFor,
	gradeAgainstLadder,
	ladderComponentDisagreement,
	PASSING_GRADES,
	UNCONSTRAINED_RUNG,
} from "#eval-harness/gauntlet/ablation-expectation"
import { AblationGazetteer } from "#eval-harness/gauntlet/ablation-gazetteer"
// The renderer and the data shapes moved out when the expectation model pushed this file past the 750-line cap. Both
// are re-exported below, from their historical home, so every importer and every test keeps its path.
import { renderAblationMarkdown } from "#eval-harness/gauntlet/ablation-report"
import {
	aggregateAblationComponents,
	ABLATABLE_COMPONENTS,
	type AblatableComponent,
	type AblationCell,
	type AblationRowOutcome,
	type AblationSkip,
	type AblationVariant,
	DEFAULT_ABLATION_TOLERANCE_KM,
	type SlotOutcome,
} from "#eval-harness/gauntlet/ablation-types"
import { loadRegressionCases } from "#eval-harness/gauntlet/cases/load"
import { componentOf } from "#eval-harness/gauntlet/check-case"
import { assertCorpusStampFresh } from "#eval-harness/gauntlet/corpus-stamp"
import { buildGauntletDeps, type GauntletResult, runOne } from "#eval-harness/gauntlet/harness"
import { type GauntletLayerOptions, layerDepsOptions } from "#eval-harness/gauntlet/regression"
import type { GauntletDatabase, ResolutionTier } from "#eval-harness/gauntlet/schema"

export { ABLATION_ABSENT } from "#eval-harness/gauntlet/ablation-expectation"

export {
	formatAblationCell,
	formatAblationLadderCell,
	renderAblationMarkdown,
} from "#eval-harness/gauntlet/ablation-report"

export {
	ABLATABLE_COMPONENTS,
	DEFAULT_ABLATION_TOLERANCE_KM,
	type AblatableComponent,
	type AblationCell,
	type AblationRowOutcome,
	type AblationSkip,
	type AblationVariant,
	type SlotOutcome,
} from "#eval-harness/gauntlet/ablation-types"

/**
 * How many substitutions the console summary lists before it truncates. Purely a terminal-legibility cap — the full
 * list is always in the artifact's `rows`, and the summary says how many it withheld. Sized against the S-2 baseline
 * (16 substitutions on the postcode column alone), so a run whose substitution rate is normal prints in full.
 */
const SUBSTITUTION_PRINT_LIMIT = 60

const WORD_CHAR = /[\p{L}\p{N}]/u

function isWordChar(c: string | undefined): boolean {
	return c !== undefined && WORD_CHAR.test(c)
}

/**
 * Every boundary-safe, case-insensitive occurrence of `value` in `input`, as start offsets.
 *
 * Boundary-safe means the character on each side is not a letter or digit. This is the guard that keeps a locality
 * `York` from being carved out of a region `New York` — the class of defect that survives review precisely because it
 * needs a corpus row where one asserted span nests inside another, and this corpus has them (`New York` / `NY`,
 * `Brooklyn` / `Park Slope`). A plain `indexOf`, which is what S-2's single-component stripper could afford, silently
 * mutilates the neighbour.
 */
export function boundedOccurrences(input: string, value: string): number[] {
	if (!value) return []

	const haystack = input.toLowerCase()
	const needle = value.toLowerCase()
	const hits: number[] = []
	let from = 0

	for (;;) {
		const at = haystack.indexOf(needle, from)

		if (at === -1) break

		from = at + 1

		if (isWordChar(input[at - 1])) continue

		if (isWordChar(input[at + needle.length])) continue

		hits.push(at)
	}

	return hits
}

/**
 * Delete `[at, at + length)` and tidy the separator debris the cut leaves behind. Deliberately LITERAL — the whole
 * reason this runner does not reuse metamorphic's `\b\d{5}\b` stripper is that a pattern deletes house numbers on the
 * 4-digit postal systems (the postcode arc's M-1 finding, in reverse).
 */
export function deleteSpan(input: string, at: number, length: number): string {
	return (
		(input.slice(0, at) + input.slice(at + length))
			.replaceAll(/\s{2,}/g, " ")
			.replaceAll(/\s+,/g, ",")
			.replaceAll(/,\s*,/g, ",")
			// Leading/trailing separator debris: deleting a leading postcode ("75013 Paris") or a trailing country
			// ("…, France") strips the token and leaves the comma orphaned at the edge.
			.replace(/^[\s,]+/, "")
			.replace(/[\s,]+$/, "")
	)
}

/**
 * The deletion variants a row's asserted components support, plus the components refused and why.
 *
 * Four refusals, each one a class the corpus actually contains:
 *
 * 1. `empty` — the asserted value is the empty string. `us-dc-pennsylvania` asserts `postcode: ""` to pin that the slot
 *    stays EMPTY; there is nothing to delete, and treating it as a deletion would manufacture support.
 * 2. `not-verbatim` — the asserted value is not in the input (an assertion about the RESOLVED value, e.g. `country:
 *    "United States"` against an input saying `USA`). Deleting it would require guessing which span it came from.
 * 3. `ambiguous` — more than one boundary-safe occurrence, or the same value asserted for a second component. Either way
 *    the deletion is not attributable to one component, which is the only thing this map measures.
 * 4. `nested` — the value is a proper substring of another asserted component's value (`York` inside `New York`). Deleting
 *    it damages the neighbour, so the row would measure a two-component deletion under one component's name.
 */
export function ablationVariants(
	input: string,
	components: Record<string, string>,
	only?: ReadonlySet<AblatableComponent>
): { variants: AblationVariant[]; skips: AblationSkip[] } {
	const variants: AblationVariant[] = []
	const skips: AblationSkip[] = []

	const asserted = ABLATABLE_COMPONENTS.filter((tag) => tag in components).map((tag) => ({
		tag,
		value: (components[tag] ?? "").trim(),
	}))

	for (const { tag, value } of asserted) {
		if (only && !only.has(tag)) continue

		if (!value) {
			skips.push({ component: tag, value, reason: "empty" })

			continue
		}

		const lower = value.toLowerCase()
		const twin = asserted.find((o) => o.tag !== tag && o.value.toLowerCase() === lower)

		if (twin) {
			skips.push({ component: tag, value, reason: `ambiguous: same value asserted for ${twin.tag}` })

			continue
		}

		const host = asserted.find(
			(o) => o.tag !== tag && o.value.length > value.length && o.value.toLowerCase().includes(lower)
		)

		if (host) {
			skips.push({ component: tag, value, reason: `nested inside ${host.tag} "${host.value}"` })

			continue
		}

		const hits = boundedOccurrences(input, value)

		if (!hits.length) {
			skips.push({ component: tag, value, reason: "not-verbatim" })

			continue
		}

		if (hits.length > 1) {
			skips.push({ component: tag, value, reason: `ambiguous: ${hits.length} occurrences` })

			continue
		}

		const at = hits[0]!
		const ablated = deleteSpan(input, at, value.length)

		if (!ablated || ablated === input) {
			skips.push({ component: tag, value, reason: "deletion left the input unchanged or empty" })

			continue
		}

		variants.push({ component: tag, deleted: input.slice(at, at + value.length), input: ablated })
	}

	return { variants, skips }
}

/**
 * Fold to the comparison form used for slot classification: lowercase, alphanumerics only. `BT3 9QQ` and `bt39qq` are
 * the same postcode; `1600` and `BT3 9QQ` are not.
 */
function foldValue(value: string | null): string {
	return (value ?? "").toLowerCase().replaceAll(/[^\p{L}\p{N}]/gu, "")
}

/**
 * What the ablated arm did with the deleted component's slot. `substituted` is the S-2 finding-3 class and the one a
 * completion nudge has to fear: the slot reads as filled, so a naive layer abstains — or confirms a house number as a
 * postcode.
 */
export function classifySlot(deleted: string, emitted: string | null): SlotOutcome {
	const got = foldValue(emitted)

	if (!got) return "absent"

	return got === foldValue(deleted) ? "recovered" : "substituted"
}

/**
 * Coarseness rank: higher is more precise. The tier ladder is `address_point → interpolated → street → admin`, and a
 * deletion that walks DOWN it has cost the user precision even when the coordinate barely moved.
 */
export function tierRank(tier: ResolutionTier): number {
	switch (tier) {
		// A resolved entity is house-grade — the poi row is the venue's own point, peer of a situs hit.
		// A decoded plus code is the user's own house-grade claim, peer of both.
		case "venue":
		case "address_point":
		case "plus_code":
			return 4
		case "interpolated":
			return 3
		case "street":
			return 2
		case "admin":
			return 1
	}
}

export function isTierDrop(anchor: ResolutionTier, ablated: ResolutionTier): boolean {
	return tierRank(ablated) < tierRank(anchor)
}

/**
 * Score one deletion against its own anchor. Pure: the two {@linkcode GauntletResult}s are the only inputs, so the
 * scoring rule is testable without the ~9 GB database set.
 */
export function scoreAblation(
	anchor: GauntletResult,
	ablated: GauntletResult,
	deleted: string,
	component: AblatableComponent,
	toleranceKm: number
): Pick<AblationRowOutcome, "displacementKm" | "broken" | "tierDrop" | "unresolved" | "slot" | "emitted"> {
	const anchorResolved = anchor.lat != null && anchor.lon != null
	const ablatedResolved = ablated.lat != null && ablated.lon != null

	const displacementKm =
		anchorResolved && ablatedResolved ? haversineKm(anchor.lat!, anchor.lon!, ablated.lat!, ablated.lon!) : null

	const emitted = componentOf(ablated, component)

	return {
		displacementKm,
		// A row whose own anchor never resolved is NOT gradable — reporting it as held would be the meaning-of-zero
		// trap one level down. A resolved anchor with an unresolved ablated arm IS broken: the answer is gone.
		broken: !anchorResolved ? null : !ablatedResolved ? true : displacementKm! > toleranceKm,
		tierDrop: isTierDrop(anchor.tier, ablated.tier),
		unresolved: !ablatedResolved,
		slot: classifySlot(deleted, emitted),
		emitted,
	}
}

/**
 * Fold per-row outcomes into the (component, locale) map. A pair with no rows produces NO cell — see
 * {@linkcode AblationCell.support}.
 */
export function aggregateCells(
	rows: readonly AblationRowOutcome[],
	meta: { boardID: string; measuredAt: string }
): AblationCell[] {
	const groups = new Map<string, AblationRowOutcome[]>()

	for (const row of rows) {
		const key = `${row.component}|${row.locale}`
		const bucket = groups.get(key)

		if (bucket) {
			bucket.push(row)
		} else {
			groups.set(key, [row])
		}
	}

	const cells: AblationCell[] = []

	for (const bucket of groups.values()) {
		const first = bucket[0]!
		const graded = bucket.filter((r) => r.displacementKm != null).map((r) => r.displacementKm!)
		const grades = emptyGrades()

		for (const row of bucket) {
			grades[row.grade]++
		}

		const ladderGraded = bucket.filter((r) => r.grade !== "ungraded")
		const fell = ladderGraded.filter((r) => r.degradedRungs != null).map((r) => r.degradedRungs!)

		cells.push({
			component: first.component,
			locale: first.locale,
			support: bucket.length,
			brokenCount: bucket.filter((r) => r.broken === true).length,
			// `percentile` returns null on an empty sample; a cell whose anchors all failed has no displacement
			// distribution, and -1 would be a number the reader could average. Encode it as NaN-free absence via
			// gradedCount === 0 — the consumer's rule is "skip a cell you cannot read", same as support 0.
			displacementKmP50: percentile(graded, 50) ?? 0,
			displacementKmP90: percentile(graded, 90) ?? 0,
			tierDropCount: bucket.filter((r) => r.tierDrop).length,
			unresolvedCount: bucket.filter((r) => r.unresolved).length,
			substitutedCount: bucket.filter((r) => r.slot === "substituted").length,
			toleranceKm: DEFAULT_ABLATION_TOLERANCE_KM,
			boardID: meta.boardID,
			measuredAt: meta.measuredAt,
			recoveredCount: bucket.filter((r) => r.slot === "recovered").length,
			anchorUnresolvedCount: bucket.filter((r) => r.broken === null).length,
			gradedCount: graded.length,
			ladderGradedCount: ladderGraded.length,
			grades,
			trueFailCount: ladderGraded.filter((r) => !PASSING_GRADES.has(r.grade)).length,
			correctlyDegradedCount: grades.degraded,
			correctlyAbstainedCount: grades.correctlyAbstained,
			degradedRungsP50: percentile(fell, 50),
			degradedRungsMax: fell.length ? Math.max(...fell) : null,
			unconstrainedCount: bucket.filter((r) => r.expectedRung === UNCONSTRAINED_RUNG).length,
		})
	}

	return cells.toSorted((a, b) => a.component.localeCompare(b.component) || a.locale.localeCompare(b.locale))
}

/**
 * Options for {@linkcode runAblationLayer} — the shared layer options (model ladder + resolver lever pins) plus this
 * layer's own three.
 */
export interface AblationLayerOptions extends GauntletLayerOptions {
	/**
	 * Where the artifacts land. Defaults to `/tmp/ablation-<YYYYMMDD-HHmm>` — the `promotion-gate.ts` convention, and
	 * deliberately NOT under `$MAILWOMAN_DATA_ROOT`, which this layer only ever reads.
	 */
	outDir?: string
	/**
	 * Restrict the deleted components (default: all of {@linkcode ABLATABLE_COMPONENTS}).
	 */
	components?: readonly string[]
	/**
	 * Cap the number of CASES (not variants). For a smoke run.
	 */
	limit?: number
}

interface CaseRow {
	id: string
	input: string
	country: string
	status: string
	default_country: string | null
	expect_components: string | null
	expect_tolerance_m: number | null
	/**
	 * The row's asserted coordinate — rung 0 of its degradation ladder when it has one (see {@linkcode buildCaseLadder}).
	 */
	expect_lat: number | null
	expect_lon: number | null
}

/**
 * The per-case `ablation_expect` pins, keyed by case id.
 *
 * Read from the built DB when the column is there, and from the COMMITTED SEED otherwise. The dual path is not
 * belt-and-braces: `ablation_expect` landed with the expectation model (2026-08-05) and the shared
 * `$MAILWOMAN_DATA_ROOT/gauntlet/regression.db` predates it, so a layer that only read the column would silently ignore
 * every pin until someone rebuilt a database this layer has no business rebuilding. The seed is the authoring surface
 * either way (`cases/<cc>/*.jsonl`), so the two agree by construction once the rebuild happens.
 */
export async function ablationOverrides(db: DatabaseClient<GauntletDatabase>): Promise<{
	byCaseID: Map<string, Record<string, string>>
	source: "column" | "seed"
}> {
	const hasColumn = (db.prepare(`PRAGMA table_info(gauntlet_case)`).all() as Array<{ name: string }>).some(
		(c) => c.name === "ablation_expect"
	)

	const byCaseID = new Map<string, Record<string, string>>()

	if (hasColumn) {
		const rows = db
			.prepare(`SELECT id, ablation_expect FROM gauntlet_case WHERE ablation_expect IS NOT NULL`)
			.all() as Array<{ id: string; ablation_expect: string }>

		for (const row of rows) {
			const parsed = tryParsingJSON<Record<string, string>>(row.ablation_expect)

			if (parsed) {
				byCaseID.set(row.id, parsed)
			}
		}

		return { byCaseID, source: "column" }
	}

	for (const seed of await loadRegressionCases()) {
		if (seed.ablationExpect) {
			byCaseID.set(seed.id, seed.ablationExpect)
		}
	}

	return { byCaseID, source: "seed" }
}

/**
 * A stable identity for the board a cell was measured on: the corpus's own content, not its file mtime. Two runs over
 * the same rows share a `boardID`; a row added or an input edited changes it, so a stale cell can never be silently
 * compared against a fresh one.
 */
export function ablationBoardID(cases: readonly { id: string; input: string }[]): string {
	const fingerprint = cases
		.map((c) => `${c.id} ${c.input}`)
		.toSorted()
		.join("")

	return `gauntlet-regression@${cases.length}:${sha256Hex(fingerprint).slice(0, 12)}`
}

function timestampDir(now: Date): string {
	const iso = now.toISOString()

	return `/tmp/ablation-${iso.slice(0, 10).replaceAll("-", "")}-${iso.slice(11, 16).replace(":", "")}`
}

/**
 * Run the ablation layer over the curated corpus. Returns `pass` — which reports only whether the INSTRUMENT ran (at
 * least one measured cell). A map is not a gate; nothing here can fail a ship.
 */
export async function runAblationLayer(
	options: AblationLayerOptions = {}
): Promise<{ pass: boolean; outDir: string; cells: AblationCell[] }> {
	const kdb = new DatabaseClient<GauntletDatabase>(dataRootPath("gauntlet", "regression.db"), { readOnly: true })
	// Same refusal as the regression layer: this artifact's board id claims to identify a corpus, so a stale DB
	// would publish an ablation board under a fingerprint the corpus no longer has (corpus-stamp.ts).
	await assertCorpusStampFresh(kdb)

	const allCases = (await kdb
		.selectFrom("gauntlet_case")
		.select([
			"id",
			"input",
			"country",
			"status",
			"default_country",
			"expect_components",
			"expect_tolerance_m",
			"expect_lat",
			"expect_lon",
		])
		.orderBy("id")
		.execute()) as CaseRow[]

	// Read the pins off the SAME handle before it closes — see `ablationOverrides` for why the column may not be there.
	const overrides = await ablationOverrides(kdb)

	await kdb.destroy()

	const boardID = ablationBoardID(allCases)
	const measuredAt = new Date().toISOString()
	const outDir = options.outDir ?? timestampDir(new Date())
	const cases = options.limit ? allCases.slice(0, options.limit) : allCases

	const only = options.components?.length
		? new Set(
				options.components.filter((c): c is AblatableComponent =>
					(ABLATABLE_COMPONENTS as readonly string[]).includes(c)
				)
			)
		: undefined

	if (options.components?.length && !only?.size) {
		throw new Error(
			`--components matched no ablatable tag. Known: ${ABLATABLE_COMPONENTS.join(", ")}. Got: ${options.components.join(", ")}`
		)
	}

	const deps = await buildGauntletDeps(layerDepsOptions(options))
	const gazetteer = await AblationGazetteer.create()

	// LOUD, because a ladder-less run and a run where nothing degraded produce the same all-`held` shape until you
	// read `ladderGradedCount`. The map still measures the anchor-graded columns without it.
	console.error(
		gazetteer.available
			? `[ablation] expectation model: ladders from admin-global-priority.db + candidate.db (overrides from the ${overrides.source}, ${overrides.byCaseID.size} pinned)`
			: `[ablation] ⚠ NO EXPECTATION MODEL — ${gazetteer.unavailableReason}. Every variant grades \`ungraded\`; only the anchor-graded columns mean anything.`
	)

	const rows: AblationRowOutcome[] = []
	const skips: Array<AblationSkip & { caseID: string }> = []
	const ladderProblems: Array<{ caseID: string; reason: string }> = []
	let anchorsRun = 0

	try {
		for (const c of cases) {
			const components = c.expect_components ? tryParsingJSON<Record<string, string>>(c.expect_components) : null

			if (!components) continue

			const { variants, skips: caseSkips } = ablationVariants(c.input, components, only)

			for (const s of caseSkips) {
				skips.push({ ...s, caseID: c.id })
			}

			if (!variants.length) continue

			// caseCountry selects the per-locale weights OVERLAY, exactly as the regression layer does. Without it
			// the GB/DE/IN rows grade base-only and their dependent_locality never fires — the R1 instrument trap.
			const geoOpts = {
				...(c.default_country ? { defaultCountry: c.default_country } : {}),
				...(c.country ? { caseCountry: c.country } : {}),
			}

			const anchor = await runOne(c.input, deps, geoOpts)

			anchorsRun++

			const toleranceKm = (c.expect_tolerance_m ?? DEFAULT_ABLATION_TOLERANCE_KM * 1000) / 1000

			const drawn = gazetteer.available
				? buildCaseLadder(anchor, toleranceKm, gazetteer, { lat: c.expect_lat, lon: c.expect_lon }, c.country)
				: { ladder: null, reason: gazetteer.unavailableReason ?? "no gazetteer" }

			// A ladder has to be about THIS address. The check only ever fires on a row that asserts no coordinate (its
			// rung 0 is the pipeline's own undeleted answer); when that answer is somewhere else, the ladder is drawn
			// around the wrong town and every deletion on it grades against a place the row never claimed.
			const disagreement = drawn.ladder ? ladderComponentDisagreement(components, drawn.ladder, gazetteer) : null

			const built = disagreement ? { ladder: null, reason: disagreement } : drawn

			// Where the UNDELETED case already stands on its own ladder — the floor every variant is judged from
			// (`gradeAgainstLadder`). `null` (anchor off its own ladder, or unresolved) makes the whole case ungradable,
			// which is reported rather than counted as anything.
			const anchorRungDepth =
				built.ladder && anchor.lat != null && anchor.lon != null
					? (achievedRung(anchor.lat, anchor.lon, built.ladder)?.depth ?? null)
					: null

			if (built.ladder && anchorRungDepth == null) {
				ladderProblems.push({
					caseID: c.id,
					reason: "the UNDELETED answer is off its own ladder — nothing about a deletion can be read from this row",
				})
			}

			if (built.ladder == null) {
				ladderProblems.push({ caseID: c.id, reason: built.reason })
			}

			const casePins = overrides.byCaseID.get(c.id)

			for (const v of variants) {
				const ablated = await runOne(v.input, deps, geoOpts)
				const scored = scoreAblation(anchor, ablated, v.deleted, v.component, toleranceKm)

				const expectation = expectFor({
					ladder: built.ladder,
					components,
					deleted: v.component,
					pin: casePins?.[v.component],
					gz: gazetteer,
					ablatedInput: v.input,
				})

				const graded = built.ladder
					? gradeAgainstLadder({
							expected: expectation.expected!,
							ladder: built.ladder,
							lat: ablated.lat,
							lon: ablated.lon,
							slot: scored.slot,
							anchorRungDepth,
						})
					: { grade: "ungraded" as const, achievedRungDepth: null, degradedRungs: null }

				const achievedRungName =
					built.ladder && graded.achievedRungDepth != null
						? (built.ladder.rungs[graded.achievedRungDepth]?.kind ?? null)
						: null

				rows.push({
					caseID: c.id,
					component: v.component,
					locale: c.country,
					status: c.status,
					deleted: v.deleted,
					anchorInput: c.input,
					ablatedInput: v.input,
					anchorLat: anchor.lat,
					anchorLon: anchor.lon,
					anchorTier: anchor.tier,
					ablatedLat: ablated.lat,
					ablatedLon: ablated.lon,
					ablatedTier: ablated.tier,
					toleranceKm,
					...scored,
					expectedRung: expectation.rungName,
					expectedRungDepth: expectation.depth,
					expectedWhy: expectation.why,
					expectedSource: expectation.source,
					ladderAnchor: ("anchorSource" in built ? built.anchorSource : null) as AblationRowOutcome["ladderAnchor"],
					anchorRungDepth,
					achievedRung: achievedRungName,
					achievedRungDepth: graded.achievedRungDepth,
					degradedRungs: graded.degradedRungs,
					grade: graded.grade,
					ladder: built.ladder ? describeLadder(built.ladder) : [],
					ladderGaps: built.ladder ? built.ladder.gaps.map((g) => `${g.placetype} ${g.name}: ${g.reason}`) : [],
				})

				// Two different nulls, and the progress line must not conflate them: `no-anchor` is the ROW failing to
				// resolve as written (nothing to measure against), `unresolved` is the DELETION costing the answer.
				const moved =
					scored.displacementKm != null
						? `${scored.displacementKm.toFixed(2)}km`
						: scored.broken === null
							? "no-anchor"
							: "unresolved"

				console.error(
					`${c.id}\t${v.component}\t${moved}\t${anchor.tier}→${ablated.tier}\t${scored.slot}\t` +
						`want ${expectation.rungName} got ${achievedRungName ?? "-"}\t${graded.grade}`
				)
			}
		}
	} finally {
		deps[Symbol.dispose]()
		gazetteer[Symbol.dispose]()
	}

	const cells = aggregateCells(rows, { boardID, measuredAt })
	const leverLine = describeLevers(options)

	await makeDirectories(outDir)

	const artifact = {
		boardID,
		measuredAt,
		caseCount: anchorsRun,
		variantCount: rows.length,
		toleranceKmDefault: DEFAULT_ABLATION_TOLERANCE_KM,
		levers: leverLine,
		expectationModel: {
			available: gazetteer.available,
			unavailableReason: gazetteer.unavailableReason,
			overrideSource: overrides.source,
			overrideCount: overrides.byCaseID.size,
			// Cases whose ladder could NOT be built, and why. The complement of `ladderGradedCount` at the row level,
			// kept per case so a thin expectation column is attributable to the gazetteer rather than to the parser.
			ladderProblems,
		},
		cells,
		rows,
		skips,
	}

	await writeLocalJSONFile(artifact, join(outDir, "ablation-map.json"))

	await writeLocalFile(
		renderAblationMarkdown(cells, rows, {
			boardID,
			measuredAt,
			caseCount: anchorsRun,
			variantCount: rows.length,
			skips,
			levers: leverLine,
		}),
		join(outDir, "ablation-map.md")
	)

	printSummary(cells, rows, { boardID, measuredAt, anchorsRun, outDir, leverLine, skips })

	// The instrument check, not a gate: a map of zero cells means the run measured NOTHING, and a "PASS" printed
	// over an empty map is precisely the reading the meaning-of-zero rule exists to forbid.
	return { pass: cells.length > 0, outDir, cells }
}

function describeLevers(options: AblationLayerOptions): string {
	return options.levers?.postcodeCountryCoherence === undefined
		? "resolver levers: (none pinned — production defaults)"
		: `resolver levers: postcodeCountryCoherence=${options.levers.postcodeCountryCoherence ? "ON" : "OFF"}`
}

function printSummary(
	cells: readonly AblationCell[],
	rows: readonly AblationRowOutcome[],
	meta: {
		boardID: string
		measuredAt: string
		anchorsRun: number
		outDir: string
		leverLine: string
		skips: readonly AblationSkip[]
	}
): void {
	console.log(`\n=== Gauntlet · ablation (the load-bearing map) ===`)
	console.log(`  board            ${meta.boardID}`)
	console.log(`  measured         ${meta.measuredAt}`)
	console.log(`  ${meta.leverLine}`)
	console.log(`  cases            ${meta.anchorsRun}`)
	console.log(`  variants         ${rows.length}`)
	console.log(`  cells            ${cells.length} (a (component, locale) pair with no row emits NO cell)`)
	console.log(`  artifacts        ${meta.outDir}/ablation-map.{json,md}`)

	const aggregates = aggregateAblationComponents(cells, rows)

	console.log(`\nper component (all locales):`)
	console.log(
		`  ${"component".padEnd(20)}${"support".padStart(8)}${"broken".padStart(8)}${"p50 km".padStart(11)}${"p90 km".padStart(11)}${"tier↓".padStart(7)}${"unres".padStart(7)}${"subst".padStart(7)}`
	)

	for (const aggregate of aggregates) {
		console.log(
			`  ${aggregate.component.padEnd(20)}${String(aggregate.support).padStart(8)}${String(aggregate.brokenCount).padStart(8)}` +
				`${(aggregate.displacementKmP50 == null ? ABLATION_ABSENT : aggregate.displacementKmP50.toFixed(2)).padStart(11)}${(aggregate.displacementKmP90 == null ? ABLATION_ABSENT : aggregate.displacementKmP90.toFixed(2)).padStart(11)}` +
				`${String(aggregate.tierDropCount).padStart(7)}${String(aggregate.unresolvedCount).padStart(7)}` +
				`${String(aggregate.substitutedCount).padStart(7)}`
		)
	}

	const ladderGraded = rows.filter((r) => r.grade !== "ungraded")

	console.log(`\nper component, the EXPECTATION model (held+degraded+abstained are PASSES):`)
	console.log(
		`  ${"component".padEnd(20)}${"graded".padStart(8)}${"FAIL".padStart(7)}${"held".padStart(7)}${"degr".padStart(7)}` +
			`${"abst".padStart(7)}${"lost".padStart(7)}${"overc".padStart(7)}${"homon".padStart(7)}${"coars".padStart(7)}${"wrong".padStart(7)}${"subst".padStart(7)}${"unconstr".padStart(10)}`
	)

	for (const aggregate of aggregates) {
		if (!aggregate.ladderGradedCount) continue

		const n = (grade: AblationGrade): string => String(aggregate.grades[grade]).padStart(7)

		console.log(
			`  ${aggregate.component.padEnd(20)}${String(aggregate.ladderGradedCount).padStart(8)}${String(aggregate.trueFailCount).padStart(7)}` +
				`${n("held")}${n("degraded")}${n("correctlyAbstained")}${n("lost")}${n("overconfident")}${n("homonymTakeover")}${n("coarser")}${n("wrong")}${n("substituted")}` +
				`${String(aggregate.unconstrainedCount).padStart(10)}`
		)
	}

	// The headline the operator asked for, in one line each: the old verdict, the new one, and the size of the
	// difference between them. Printed even at zero, because "0 rows were misgraded" is a measurement here — but
	// only when the ladder actually graded something, which the `ungraded` count states outright.
	const ungraded = rows.length - ladderGraded.length
	const trueFail = ladderGraded.filter((r) => !PASSING_GRADES.has(r.grade))

	console.log(
		`\n  anchor grading (pre-2026-08-05):  ${rows.filter((r) => r.broken === true).length}/${rows.length} broken`
	)
	console.log(
		`  ladder grading:                  ${trueFail.length}/${ladderGraded.length} true fail  ` +
			`(${ladderGraded.filter((r) => r.grade === "degraded").length} correctly degraded, ` +
			`${ladderGraded.filter((r) => r.grade === "correctlyAbstained").length} correctly abstained, ` +
			`${ladderGraded.filter((r) => r.grade === "held").length} held)`
	)
	console.log(
		ungraded
			? `  ungraded:                        ${ungraded} variant(s) had no ladder — NOT a pass (see \`expectationModel.ladderProblems\`)`
			: `  ungraded:                        0 — every variant had a ladder`
	)

	const substituted = rows.filter((r) => r.slot === "substituted")

	if (substituted.length) {
		console.log(`\nSUBSTITUTIONS — the deleted slot was refilled by a different span (${substituted.length}):`)

		for (const r of substituted.slice(0, SUBSTITUTION_PRINT_LIMIT)) {
			console.log(`  ${r.caseID.padEnd(40)} ${r.component.padEnd(20)} "${r.deleted}" → "${r.emitted}"`)
		}

		if (substituted.length > SUBSTITUTION_PRINT_LIMIT) {
			console.log(`  … ${substituted.length - SUBSTITUTION_PRINT_LIMIT} more (see the artifact's \`rows\`)`)
		}
	}

	const recovered = rows.filter((r) => r.slot === "recovered")

	console.log(
		`\n  slot outcomes: ${rows.filter((r) => r.slot === "absent").length} absent, ${recovered.length} recovered, ${substituted.length} substituted`
	)

	if (meta.skips.length) {
		console.log(`\n  asserted components NOT deleted: ${meta.skips.length} (see the artifact's \`skips\`)`)
	}
}
