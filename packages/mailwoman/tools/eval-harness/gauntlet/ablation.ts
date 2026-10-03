/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Gauntlet ablation layer — the required map. For every corpus row that asserts a component, delete that component
 * from the input and re-run the full pipeline: the displacement from the row's own undeleted anchor shows what the
 * component was worth, aggregated per (component, locale).
 *
 * This layer measures component ablations and does not contribute to the combined verdict. It stores no expected
 * values. Its verdict reports whether the instrument ran. A map of all-zero cells means "not measured"; it does not
 * mean "no check failed".
 *
 * Every variant grades against a graceful-degradation ladder synthesized per row from the gazetteer, with the
 * expected rung computed from the components the deletion left behind rather than from the variant's own output.
 * Three outcomes are passes: the answer held at the base rung, it coarsened to a rung the surviving evidence still
 * justifies, or it abstained where the surviving evidence justifies no pick. Substitution is a hard fail at every
 * rung, because a coordinate cannot redeem a slot refilled by the wrong token.
 *
 * Link every weights overlay before believing a number here, or the map measures the instrument.
 */

import { dataRootPath, tempRootPathBuilder } from "@mailwoman/core/data-root"
import { makeDirectories, writeLocalFile, writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { sha256Hex } from "@mailwoman/core/hash"
import { tryParsingJSON } from "@mailwoman/core/json"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { PathBuilder, type PathBuilderLike } from "path-ts"

import {
	ABLATION_ABSENT,
	type AblationGrade,
	achievedRung,
	buildCaseLadder,
	describeLadder,
	expectFor,
	gradeAgainstLadder,
	ladderComponentDisagreement,
	PASSING_GRADES,
} from "#ablation/expectation"
import { AblationGazetteer } from "#tools/eval-harness/gauntlet/ablation/gazetteer"
// Re-exported from their historical home so every importer and test keeps its path.
import { renderAblationMarkdown } from "#tools/eval-harness/gauntlet/ablation/report"
import { aggregateCells, scoreAblation } from "#tools/eval-harness/gauntlet/ablation/scoring"
import {
	aggregateAblationComponents,
	ABLATABLE_COMPONENTS,
	type AblatableComponent,
	type AblationCell,
	type AblationRowOutcome,
	type AblationSkip,
	type AblationVariant,
	DEFAULT_ABLATION_TOLERANCE_KM,
} from "#tools/eval-harness/gauntlet/ablation/types"
import { loadRegressionCases } from "#tools/eval-harness/gauntlet/cases/load"
import { assertCorpusStampFresh } from "#tools/eval-harness/gauntlet/corpus-stamp"
import { buildGauntletDeps, runOne } from "#tools/eval-harness/gauntlet/harness"
import { type GauntletLayerOptions, layerDepsOptions } from "#tools/eval-harness/gauntlet/regression"
import type { GauntletDatabase } from "#tools/eval-harness/gauntlet/schema"

export { ABLATION_ABSENT } from "#ablation/expectation"

export { aggregateCells, classifySlot, isTierDrop, scoreAblation } from "#tools/eval-harness/gauntlet/ablation/scoring"

export {
	formatAblationCell,
	formatAblationLadderCell,
	renderAblationMarkdown,
} from "#tools/eval-harness/gauntlet/ablation/report"

export {
	ABLATABLE_COMPONENTS,
	DEFAULT_ABLATION_TOLERANCE_KM,
	type AblatableComponent,
	type AblationCell,
	type AblationRowOutcome,
	type AblationSkip,
	type AblationVariant,
	type SlotOutcome,
} from "#tools/eval-harness/gauntlet/ablation/types"

/**
 * How many substitutions the console summary lists before it truncates:
 * a terminal-legibility cap only, because the full list is always in the artifact's `rows`
 * and the summary reports how many it withheld.
 */
const SUBSTITUTION_PRINT_LIMIT = 60

const WORD_CHAR = /[\p{L}\p{N}]/u

function isWordChar(c: string | undefined): boolean {
	return c !== undefined && WORD_CHAR.test(c)
}

/**
 * Every boundary-safe, case-insensitive occurrence of `value` in `input`, as start offsets,
 * where boundary-safe means the character on each side is not a letter or digit.
 *
 * This is the guard that keeps a locality `York` from being carved out of a region
 * `New York`, which a plain `indexOf` silently mutilates.
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
 * Delete `[at, at + length)` and tidy the separator debris the deletion leaves behind.
 *
 * Deliberately literal: a `\b\d{5}\b` pattern deletes house numbers on the 4-digit postal systems.
 */
export function deleteSpan(input: string, at: number, length: number): string {
	return (
		(input.slice(0, at) + input.slice(at + length))
			.replaceAll(/\s{2,}/g, " ")
			.replaceAll(/\s+,/g, ",")
			.replaceAll(/,\s*,/g, ",")
			// Leading/trailing separator debris: deleting a leading postcode ("75013 Paris") or a trailing country ("…, France") strips the token and leaves the comma orphaned at the edge.
			.replace(/^[\s,]+/, "")
			.replace(/[\s,]+$/, "")
	)
}

/**
 * The deletion variants a row's asserted components support, plus the components refused and why.
 *
 * Four refusals, each one a class the corpus actually contains:
 *
 * 1. `empty` — the asserted value is the empty string.
 *    `us-dc-pennsylvania` asserts `postcode: ""` to pin that the slot stays empty.
 *    An empty asserted value gives the ablation no text to remove.
 *    A deletion count would create support.
 * 2. `not-verbatim` — the asserted value is not in the input (an assertion about the
 *    resolved value, e.g. `country: "United States"` against an input saying `USA`).
 *    A deletion would require guessing which span it came from.
 * 3. `ambiguous` — more than one boundary-safe occurrence, or the same value
 *    asserted for a second component.
 *    Neither case attributes a deletion to one component.
 *    This map measures component-level deletions.
 * 4. `nested` — the value is a proper substring of another asserted component's
 *    value (`York` inside `New York`).
 *    Its deletion damages the neighbor, so the row would measure a two-component
 *    deletion under one component's name.
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
 * Options for {@linkcode runAblationLayer} — the shared layer options
 * (model ladder + resolver pin pins) plus this layer's own three.
 */
export interface AblationLayerOptions extends GauntletLayerOptions {
	/**
	 * Where the artifacts land.
	 *
	 * Defaults to `<temp-root>/ablation-<yyyymmdd-HHmm>`, under `$MAILWOMAN_TEMP_ROOT`.
	 * The promotion eval uses the same convention.
	 *
	 * The directory is deliberately not under `$MAILWOMAN_DATA_ROOT`, which this layer only ever reads.
	 */
	outDir?: PathBuilderLike
	/**
	 * Restrict the deleted components (default: all of {@linkcode ABLATABLE_COMPONENTS}).
	 */
	components?: readonly string[]
	/**
	 * Cap the number of cases (not variants).
	 *
	 * For a smoke run.
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
	 * The row's asserted coordinate — rung 0 of its degradation ladder
	 * when it has one (see {@linkcode buildCaseLadder}).
	 */
	expect_lat: number | null
	expect_lon: number | null
}

/**
 * The per-case `ablation_expect` pins, keyed by case id.
 *
 * Read from the built DB when it has the column.
 * Otherwise, read from the committed seed.
 *
 * The dual path is not belt-and-braces: `ablation_expect` landed with the expectation
 * model (2026-08-05) and the shared `$MAILWOMAN_DATA_ROOT/gauntlet/regression.db`
 * predates it, so a layer that only read the column would silently ignore every pin
 * until someone rebuilt a database this layer has no business rebuilding.
 *
 * The seed is the authoring surface either way (`cases/<cc>/*.jsonl`),
 * so the two agree by construction once the rebuild happens.
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
 * A stable identity for the board a cell was measured on: the corpus's own content
 * rather than its file mtime.
 *
 * Two runs over the same rows share a `boardID`; a row added or an input edited changes it,
 * so a stale cell can never be silently compared against a fresh one.
 */
export function ablationBoardID(cases: readonly { id: string; input: string }[]): string {
	const fingerprint = cases
		.map((c) => `${c.id}\0${c.input}`)
		.toSorted()
		.join("")

	return `gauntlet-regression@${cases.length}:${sha256Hex(fingerprint).slice(0, 12)}`
}

function timestampDir(now: Date): PathBuilder {
	const iso = now.toISOString()

	return tempRootPathBuilder(`ablation-${iso.slice(0, 10).replaceAll("-", "")}-${iso.slice(11, 16).replace(":", "")}`)
}

/**
 * Run the ablation layer over the curated corpus.
 *
 * @returns `pass` — which reports only whether the instrument ran (at least one measured cell).
 * A map is not a check.
 * No result here can fail a ship.
 */
export async function runAblationLayer(
	options: AblationLayerOptions = {}
): Promise<{ pass: boolean; outDir: string; cells: AblationCell[] }> {
	const kdb = new DatabaseClient<GauntletDatabase>(dataRootPath("gauntlet", "regression.db"), { readOnly: true })
	// Same refusal as the regression layer: this artifact's board id claims to identify
	// a corpus, so a stale DB would publish an ablation board under a fingerprint
	// the corpus no longer has (corpus-stamp.ts).
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

	// Read the pins off the same handle before it closes.
	// See `ablationOverrides` for why the column may not be there.
	const overrides = await ablationOverrides(kdb)

	await kdb.destroy()

	const boardID = ablationBoardID(allCases)
	const measuredAt = new Date().toISOString()
	const outDir = PathBuilder.from(options.outDir ?? timestampDir(new Date()))
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

	// loud, because a ladder-less run and a run where no rung degraded produce the
	// same all-`held` shape until you read `ladderGradedCount`.
	// The map still measures the anchor-graded columns without it.
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

			// caseCountry selects the per-locale weights overlay, exactly as the regression layer does.
			// Without it the GB/DE/IN rows grade base-only and their dependent_locality
			// never fires — the R1 instrument trap.
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

			// A ladder has to be about this address.
			// The check only ever fires on a row that asserts no coordinate
			// (its rung 0 is the pipeline's own undeleted answer); when that answer is
			// somewhere else, the ladder is drawn around the wrong town and every deletion
			// on it grades against a place the row never claimed.
			const disagreement = drawn.ladder ? ladderComponentDisagreement(components, drawn.ladder, gazetteer) : null

			const built = disagreement ? { ladder: null, reason: disagreement } : drawn

			// Where the undeleted case already stands on its own ladder.
			// The floor every variant is judged from (`gradeAgainstLadder`).
			// `null` means the anchor is off its ladder or unresolved.
			// The case is ungradable and reported separately.
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

				// The progress line keeps two null cases separate.
				// `no-anchor` means the row failed to resolve as written, leaving no anchor to measure against.
				// `unresolved` means the deletion cost the answer.
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
	const pinLine = describePins(options)

	await makeDirectories(outDir)

	const artifact = {
		boardID,
		measuredAt,
		caseCount: anchorsRun,
		variantCount: rows.length,
		toleranceKmDefault: DEFAULT_ABLATION_TOLERANCE_KM,
		pins: pinLine,
		expectationModel: {
			available: gazetteer.available,
			unavailableReason: gazetteer.unavailableReason,
			overrideSource: overrides.source,
			overrideCount: overrides.byCaseID.size,
			// Cases whose ladder could not be built, with the reason.
			// The complement of `ladderGradedCount` at the row level, kept per case so a thin
			// expectation column is attributable to the gazetteer rather than to the parser.
			ladderProblems,
		},
		cells,
		rows,
		skips,
	}

	await writeLocalJSONFile(artifact, outDir("ablation-map.json"))

	await writeLocalFile(
		renderAblationMarkdown(cells, rows, {
			boardID,
			measuredAt,
			caseCount: anchorsRun,
			variantCount: rows.length,
			skips,
			pins: pinLine,
		}),
		outDir("ablation-map.md")
	)

	printSummary(cells, rows, { boardID, measuredAt, anchorsRun, outDir: outDir.toString(), pinLine, skips })

	// This instrument measures rows rather than checking them.
	// A map of zero cells means the run measured no row.
	// A "pass" over an empty map would report success when the run measured no rows.
	return { pass: cells.length > 0, outDir: outDir.toString(), cells }
}

function describePins(options: AblationLayerOptions): string {
	return options.pins?.postcodeCountryCoherence === undefined
		? "resolver pins: (none pinned — production defaults)"
		: `resolver pins: postcodeCountryCoherence=${options.pins.postcodeCountryCoherence ? "ON" : "OFF"}`
}

function printSummary(
	cells: readonly AblationCell[],
	rows: readonly AblationRowOutcome[],
	meta: {
		boardID: string
		measuredAt: string
		anchorsRun: number
		outDir: string
		pinLine: string
		skips: readonly AblationSkip[]
	}
): void {
	console.log(`\n=== Gauntlet · ablation (the required map) ===`)
	console.log(`  board            ${meta.boardID}`)
	console.log(`  measured         ${meta.measuredAt}`)
	console.log(`  ${meta.pinLine}`)
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

	// Print the old verdict, new verdict and difference on separate lines.
	// Print these values at zero too.
	// "0 rows were misgraded" is a measurement only when the ladder graded at least one row.
	// The `ungraded` count makes that denominator clear.
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
