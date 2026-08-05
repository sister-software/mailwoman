/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Gauntlet ABLATION layer — the load-bearing map. For every corpus row that ASSERTS a component, delete
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
 *   - `regression.ts`'s `componentOf` maps an `expect_components` key to the assembled-result field. Reused
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
 *   Run: mailwoman eval gauntlet --layer ablation [--components postcode,street] [--limit 20] [--out DIR]
 */

import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { DatabaseClient } from "@mailwoman/core/kysley/client"
import { tryParsingJSON } from "@mailwoman/core/objects"
import type { ComponentTag } from "@mailwoman/core/types"
import { dataRootPath, formatPercent, percentile, sha256Hex } from "@mailwoman/core/utils"
import { haversineKm } from "@mailwoman/spatial"

import { buildGauntletDeps, type GauntletResult, runOne } from "./harness.ts"
import { componentOf, type GauntletLayerOptions, layerDepsOptions } from "./regression.ts"
import type { GauntletDatabase, ResolutionTier } from "./schema.ts"

/**
 * The component classes this runner deletes — every tag the curated corpus actually asserts, and every one
 * {@linkcode componentOf} can read back off the assembled result (the slot a substitution would land in). A tag with no
 * result field could be deleted but not scored for substitution, which is half a measurement; adding one means adding
 * the field to `GauntletResult` first.
 */
export const ABLATABLE_COMPONENTS = [
	"postcode",
	"house_number",
	"street",
	"locality",
	"dependent_locality",
	"region",
	"country",
	"unit",
	"venue",
] as const satisfies readonly ComponentTag[]

export type AblatableComponent = (typeof ABLATABLE_COMPONENTS)[number]

/**
 * Fallback displacement band, in km, for a row that asserts no `expect_tolerance_m`. Rows that DO assert one are graded
 * against theirs — a row pinned to an 80 m rooftop and a row pinned to a 500 km "in NY not France" guard are not asking
 * the same question, and one band for both would answer neither. The per-row value used is recorded on every row of the
 * JSON artifact.
 */
export const DEFAULT_ABLATION_TOLERANCE_KM = 5

/**
 * How many substitutions the console summary lists before it truncates. Purely a terminal-legibility cap — the full
 * list is always in the artifact's `rows`, and the summary says how many it withheld. Sized against the S-2 baseline
 * (16 substitutions on the postcode column alone), so a run whose substitution rate is normal prints in full.
 */
const SUBSTITUTION_PRINT_LIMIT = 60

/**
 * One cell of the deletion-ablation map: what deleting `component` costs in `locale`, on a named board. The suggestion
 * layer reads this as a per-(component, locale) prior on nudge value; §C.5 of its design doc specifies the first eleven
 * fields and this runner owes them exactly. The last three are additive and marked as such — each exists because a
 * specced field is not interpretable without it.
 */
export interface AblationCell {
	component: AblatableComponent
	/**
	 * ISO-3166 alpha-2, matching the board's own `country` column — STATED by the corpus row, never inferred from the
	 * input. (The design doc allows BCP-47 "matching whatever the board keys by"; this board keys by country.)
	 */
	locale: string
	/**
	 * Board rows that CARRY this component in this locale — the denominator behind every rate below. A cell with
	 * `support: 0` means NOT MEASURED HERE, and a consumer must represent that as absence rather than as a zero score
	 * (the meaning-of-zero rule). This runner never EMITS a zero-support cell: a (component, locale) pair with no rows is
	 * absent from the array, and {@linkcode formatAblationCell} renders a missing lookup and a zero-support one
	 * identically.
	 */
	support: number
	/**
	 * Rows whose assembled coordinate moved further than the row's tolerance once the component was deleted. A row whose
	 * ablated arm produced NO coordinate counts as broken too — losing the answer is not a small displacement.
	 */
	brokenCount: number
	displacementKmP50: number
	displacementKmP90: number
	/**
	 * Rows whose `resolution_tier` coarsened (address_point → interpolated → street → admin).
	 */
	tierDropCount: number
	/**
	 * Rows that produced no coordinate at all without the component.
	 */
	unresolvedCount: number
	/**
	 * Rows where the deleted component's SLOT was refilled by a DIFFERENT span — S-2's finding 3 (a house number emitted
	 * as the postcode). Distinct from `brokenCount`: a refill can leave the coordinate intact and still make a completion
	 * nudge unsafe, because the slot the nudge wanted to fill reads as already filled.
	 */
	substitutedCount: number
	/**
	 * The fallback band ({@linkcode DEFAULT_ABLATION_TOLERANCE_KM}); a row asserting its own `expect_tolerance_m` was
	 * graded against that instead. Per-row values are in the artifact's `rows`.
	 */
	toleranceKm: number
	/**
	 * Which board this was measured on, and when. A cell without both is not a measurement.
	 */
	boardID: string
	measuredAt: string
	/**
	 * ADDITIVE (not in §C.5): rows where the ablated arm re-emitted the SAME value the deletion removed — the resolver
	 * recovered it from the gazetteer. Without this, `substitutedCount` would have to mean "refilled by anything" and a
	 * recovery would read as a hazard. 0 of 139 on S-2's postcode column, which is itself the finding.
	 */
	recoveredCount: number
	/**
	 * ADDITIVE: rows excluded from the displacement percentiles because the row's OWN anchor never resolved. Not a
	 * failure of the deletion — there was nothing to measure against. Named so `gradedCount < support` is attributable.
	 */
	anchorUnresolvedCount: number
	/**
	 * ADDITIVE: rows where BOTH arms resolved — the denominator of `displacementKmP50` / `P90`.
	 */
	gradedCount: number
}

/**
 * One row × one deleted component: the per-case record behind a cell. Written to the artifact so any cell number can be
 * traced back to the inputs that produced it.
 */
export interface AblationRowOutcome {
	caseID: string
	component: AblatableComponent
	locale: string
	status: string
	/**
	 * The exact substring removed, as it appeared in the input (not as asserted — the search is case-insensitive).
	 */
	deleted: string
	anchorInput: string
	ablatedInput: string
	anchorLat: number | null
	anchorLon: number | null
	anchorTier: ResolutionTier
	ablatedLat: number | null
	ablatedLon: number | null
	ablatedTier: ResolutionTier
	displacementKm: number | null
	toleranceKm: number
	/**
	 * `null` when the anchor never resolved — "not gradable", which is not the same as "held".
	 */
	broken: boolean | null
	tierDrop: boolean
	unresolved: boolean
	slot: SlotOutcome
	/**
	 * What the ablated arm put in the deleted component's slot (`null` = left empty).
	 */
	emitted: string | null
}

/**
 * What happened to the deleted component's slot in the ablated arm.
 */
export type SlotOutcome = "absent" | "recovered" | "substituted"

/**
 * A component the row asserts but this runner refused to delete, and why. Reported per reason so a thin cell is
 * attributable to the corpus rather than to the pipeline — "we could not measure it" and "it did not matter" must never
 * look the same.
 */
export interface AblationSkip {
	component: AblatableComponent
	value: string
	reason: string
}

/**
 * A deletion variant: the ablated input plus the exact span removed.
 */
export interface AblationVariant {
	component: AblatableComponent
	deleted: string
	input: string
}

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
		case "address_point":
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
 * scoring rule is testable without the ~9 GB shard set.
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
		})
	}

	return cells.toSorted((a, b) => a.component.localeCompare(b.component) || a.locale.localeCompare(b.locale))
}

/**
 * The absence marker. One symbol, used for BOTH "no cell" and "support 0" — a consumer that can tell those apart can
 * still do so in the JSON, and a reader of the table must not be able to mistake either for a score.
 */
export const ABLATION_ABSENT = "·"

/**
 * Render one cell for the matrix: `broken/support` plus the p90 displacement. A missing cell or a zero-support one
 * renders as {@linkcode ABLATION_ABSENT} — never `0`, never `0.0%`. This is the meaning-of-zero rule at the only place
 * a human reads the map, and it is the reason the renderer takes `AblationCell | undefined` rather than a number.
 */
export function formatAblationCell(cell: AblationCell | undefined): string {
	if (!cell || cell.support === 0) return ABLATION_ABSENT

	return `${cell.brokenCount}/${cell.support}`
}

function cellKey(component: string, locale: string): string {
	return `${component}|${locale}`
}

/**
 * Render the map: a global per-component summary, then the component × locale matrix over the locales carrying at least
 * `minLocaleRows` rows, then the tail locales in long form. The matrix is bounded on purpose — 29 countries × 9
 * components is a table nobody reads, and folding the tail is only acceptable because it is PRINTED, not dropped.
 */
export function renderAblationMarkdown(
	cells: readonly AblationCell[],
	/**
	 * The per-row outcomes behind `cells`. Needed because percentiles do NOT aggregate: a global p90 has to be taken over
	 * the pooled displacements, not over the per-cell p90s. Pass `[]` to render the matrix alone.
	 */
	rows: readonly AblationRowOutcome[],
	meta: {
		boardID: string
		measuredAt: string
		caseCount: number
		variantCount: number
		skips: readonly { component: string; reason: string }[]
		levers: string
		minLocaleRows?: number
	}
): string {
	const minLocaleRows = meta.minLocaleRows ?? 3
	const byKey = new Map(cells.map((c) => [cellKey(c.component, c.locale), c]))
	const components = ABLATABLE_COMPONENTS.filter((tag) => cells.some((c) => c.component === tag))

	const localeSupport = new Map<string, number>()

	for (const c of cells) {
		localeSupport.set(c.locale, (localeSupport.get(c.locale) ?? 0) + c.support)
	}

	const locales = [...localeSupport.entries()].toSorted((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
	const wide = locales.filter(([, n]) => n >= minLocaleRows).map(([l]) => l)
	const tail = locales.filter(([, n]) => n < minLocaleRows).map(([l]) => l)

	const lines: string[] = [
		`# Gauntlet ablation map — the load-bearing components`,
		"",
		`- board: \`${meta.boardID}\``,
		`- measured: ${meta.measuredAt}`,
		`- ${meta.caseCount} cases → ${meta.variantCount} deletion variants (+ ${meta.caseCount} anchors)`,
		`- ${meta.levers}`,
		`- \`${ABLATION_ABSENT}\` means NOT MEASURED (no row in this corpus carries that component in that locale). It is never a score of zero.`,
		"",
		`## Per component (all locales)`,
		"",
		`| component | support | broken | broken % | p50 km | p90 km | tier drop | unresolved | substituted |`,
		`| --- | --: | --: | --: | --: | --: | --: | --: | --: |`,
	]

	for (const tag of components) {
		const own = cells.filter((c) => c.component === tag)
		const support = own.reduce((n, c) => n + c.support, 0)
		const broken = own.reduce((n, c) => n + c.brokenCount, 0)
		const tierDrop = own.reduce((n, c) => n + c.tierDropCount, 0)
		const unresolved = own.reduce((n, c) => n + c.unresolvedCount, 0)
		const substituted = own.reduce((n, c) => n + c.substitutedCount, 0)
		const pooled = rows.filter((r) => r.component === tag && r.displacementKm != null).map((r) => r.displacementKm!)
		const p50 = percentile(pooled, 50)
		const p90 = percentile(pooled, 90)

		lines.push(
			`| ${tag} | ${support} | ${broken} | ${formatPercent(broken, support)} | ` +
				`${p50 == null ? ABLATION_ABSENT : p50.toFixed(2)} | ${p90 == null ? ABLATION_ABSENT : p90.toFixed(2)} | ` +
				`${tierDrop} | ${unresolved} | ${substituted} |`
		)
	}

	lines.push("")
	lines.push(`## component × locale — broken / support`)
	lines.push("")

	// A zero-column matrix would render as a table with an empty header, which reads as a rendering bug rather
	// than as "no locale cleared the threshold". Say the latter.
	if (!wide.length) {
		lines.push(`No locale carries ${minLocaleRows} or more measured rows — every locale is in the tail below.`)
	} else {
		lines.push(`| component | ${wide.join(" | ")} |`)
		lines.push(`| --- | ${wide.map(() => "--:").join(" | ")} |`)

		for (const tag of components) {
			lines.push(`| ${tag} | ${wide.map((l) => formatAblationCell(byKey.get(cellKey(tag, l)))).join(" | ")} |`)
		}
	}

	if (tail.length) {
		lines.push("")
		lines.push(`### Locales below ${minLocaleRows} rows (printed, not dropped)`)
		lines.push("")

		for (const locale of tail) {
			const own = cells.filter((c) => c.locale === locale)

			lines.push(`- **${locale}** — ${own.map((c) => `${c.component} ${c.brokenCount}/${c.support}`).join(", ")}`)
		}
	}

	if (meta.skips.length) {
		const byReason = new Map<string, number>()

		for (const s of meta.skips) {
			// Reasons carry the offending value inline; bucket by the leading clause so the report counts CLASSES.
			const cls = s.reason.split(":")[0]!.split(" inside")[0]!

			byReason.set(cls, (byReason.get(cls) ?? 0) + 1)
		}

		lines.push("")
		lines.push(`### Asserted components NOT deleted (why a cell is thin)`)
		lines.push("")

		for (const [reason, n] of [...byReason].toSorted((a, b) => b[1] - a[1])) {
			lines.push(`- ${reason}: ${n}`)
		}
	}

	return lines.join("\n") + "\n"
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
	const raw = new DatabaseSync(dataRootPath("gauntlet", "regression.db"), { readOnly: true })
	const kdb = new DatabaseClient<GauntletDatabase>({ database: raw })

	const allCases = (await kdb
		.selectFrom("gauntlet_case")
		.select(["id", "input", "country", "status", "default_country", "expect_components", "expect_tolerance_m"])
		.orderBy("id")
		.execute()) as CaseRow[]

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

	const rows: AblationRowOutcome[] = []
	const skips: Array<AblationSkip & { caseID: string }> = []
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

			for (const v of variants) {
				const ablated = await runOne(v.input, deps, geoOpts)
				const scored = scoreAblation(anchor, ablated, v.deleted, v.component, toleranceKm)

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
				})

				// Two different nulls, and the progress line must not conflate them: `no-anchor` is the ROW failing to
				// resolve as written (nothing to measure against), `unresolved` is the DELETION costing the answer.
				const moved =
					scored.displacementKm != null
						? `${scored.displacementKm.toFixed(2)}km`
						: scored.broken === null
							? "no-anchor"
							: "unresolved"

				console.error(`${c.id}\t${v.component}\t${moved}\t${anchor.tier}→${ablated.tier}\t${scored.slot}`)
			}
		}
	} finally {
		deps.close()
	}

	const cells = aggregateCells(rows, { boardID, measuredAt })
	const leverLine = describeLevers(options)

	mkdirSync(outDir, { recursive: true })

	const artifact = {
		boardID,
		measuredAt,
		caseCount: anchorsRun,
		variantCount: rows.length,
		toleranceKmDefault: DEFAULT_ABLATION_TOLERANCE_KM,
		levers: leverLine,
		cells,
		rows,
		skips,
	}

	writeFileSync(join(outDir, "ablation-map.json"), JSON.stringify(artifact, null, "\t"))

	writeFileSync(
		join(outDir, "ablation-map.md"),
		renderAblationMarkdown(cells, rows, {
			boardID,
			measuredAt,
			caseCount: anchorsRun,
			variantCount: rows.length,
			skips,
			levers: leverLine,
		})
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

	console.log(`\nper component (all locales):`)
	console.log(
		`  ${"component".padEnd(20)}${"support".padStart(8)}${"broken".padStart(8)}${"p50 km".padStart(11)}${"p90 km".padStart(11)}${"tier↓".padStart(7)}${"unres".padStart(7)}${"subst".padStart(7)}`
	)

	for (const tag of ABLATABLE_COMPONENTS) {
		const own = rows.filter((r) => r.component === tag)

		if (!own.length) continue

		const graded = own.filter((r) => r.displacementKm != null).map((r) => r.displacementKm!)
		const p50 = percentile(graded, 50)
		const p90 = percentile(graded, 90)

		console.log(
			`  ${tag.padEnd(20)}${String(own.length).padStart(8)}${String(own.filter((r) => r.broken === true).length).padStart(8)}` +
				`${(p50 == null ? ABLATION_ABSENT : p50.toFixed(2)).padStart(11)}${(p90 == null ? ABLATION_ABSENT : p90.toFixed(2)).padStart(11)}` +
				`${String(own.filter((r) => r.tierDrop).length).padStart(7)}${String(own.filter((r) => r.unresolved).length).padStart(7)}` +
				`${String(own.filter((r) => r.slot === "substituted").length).padStart(7)}`
		)
	}

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
