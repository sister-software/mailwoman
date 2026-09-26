/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The hard-case board: the curated inputs that make an FST/importance change measurable, with the schema,
 *   zod shadow, and loader for `fixtures/hard-case-board.jsonl`. It exists because a well-formed address never
 *   puts the decoder where a soft gazetteer bias can change the argmax, so every row here exercises the bias
 *   list — bare toponyms, comma-free fragments, and namesake confounds.
 *
 *   {@linkcode HardCase.fstReach} says whether the row's expected place is inside the locale-scoped
 *   `fst-<locale>.bin` the arm loads: `in` means bias can push the parse toward the answer, `out` means the
 *   country is out of scope and the gazetteer can only pull toward a wrong place, so those rows are reported
 *   separately as the arm comparison's hijack-risk population.
 *
 *   A coordinate assertion is all-or-none — `expectLat` + `expectLon` + `expectToleranceM` together or no
 *   coordinate at all, as {@linkcode HardCaseSchema} enforces, because a silently-defaulted tolerance is a
 *   number nobody chose. A zero bias means the FST accepted no entry for that surface, not that no bias applies.
 *
 *   Graded through `createRuntimePipeline`, the only path an FST prior actually reaches (see the runner).
 */

import { resolvePackagePath } from "@mailwoman/core/module/resolvers"
import { JSONSpliterator } from "spliterator"
import zod from "zod"

import type { MutuallyAssignable, SameShape } from "#eval-harness/shape-assertions"

/**
 * What a row is testing — the reporting axis, so per-class deltas localize an arm's
 * effect to a register rather than averaging wins and losses into a single number.
 */
export const HARD_CASE_CLASSES = [
	/**
	 * Bare single toponym, namesake-prone, with a dominant referential answer ("Bordeaux").
	 */
	"bare_namesake",
	/**
	 * Tier-1 homonym lineage in comma form ("Portland, ME").
	 */
	"homonym_confound",
	/**
	 * Comma-free two-toponym fragment ("Moscow Idaho") — the FST prior's design register.
	 */
	"comma_free",
	/**
	 * The comma-containing control for a `comma_free` row: same truth, punctuation restored.
	 */
	"comma_control",
	/**
	 * Encyclopedic importance and population disagree about which bearer leads (Saint-Denis).
	 */
	"wiki_pop_conflict",
	/**
	 * A country-distinctive addressing structure.
	 */
	"country_structure",
	/**
	 * A toponym in street-head position that must not be pulled to locality.
	 */
	"street_head_control",
	/**
	 * A namesake row whose country no FST covers — pins the reach limit itself.
	 */
	"fst_out_of_reach",
] as const

export type HardCaseClass = (typeof HARD_CASE_CLASSES)[number]

/**
 * Whether this row's country is inside the shipped FST country scope: a row marked `out` is
 * expected to tie across arms, and its tie is evidence about coverage rather than about importance.
 */
export const FST_REACH = ["in", "out"] as const

export type FSTReach = (typeof FST_REACH)[number]

/**
 * One row of the hard-case board, declared in the order {@linkcode HARD_CASE_KEY_ORDER} mirrors,
 * so every emitted row keys identically and a diff shows content rather than a re-shuffle.
 */
export interface HardCase {
	id: string
	input: string
	/**
	 * The model locale this row grades under — also selects which `fst-<locale>.bin` each arm loads.
	 */
	locale: string
	/**
	 * ISO-3166 alpha-2 of the expected answer's country.
	 */
	country: string
	class: HardCaseClass
	fstReach: FSTReach
	/**
	 * The token whose gazetteer bias is under test — the reason this row is on the board.
	 */
	probeSurface: string
	/**
	 * Measured `max(importance)` for {@linkcode probeSurface} under the shipped
	 * population-proxy FST, on the BIO tag named by {@linkcode probeTag}, so a tie from
	 * "no bias difference" is distinguishable from one the decoder ignored.
	 */
	popBias: number
	/**
	 * Measured `max(importance)` for the same surface under the staged real-importance FST.
	 */
	impBias: number
	/**
	 * The BIO tag {@linkcode popBias}/{@linkcode impBias} were measured on.
	 */
	probeTag: string
	expectPlaceID?: string
	expectPlaceName?: string
	expectLat?: number
	expectLon?: number
	/**
	 * Great-circle tolerance (m); never defaulted, so a coordinate is asserted
	 * with its tolerance or not at all.
	 */
	expectToleranceM?: number
	source: string
	addedAt: string
	bugRef?: string
	note?: string
}

/**
 * Canonical key order — {@linkcode HardCase}'s declaration order, mirrored by emission
 * so the board's diff means content rather than a re-shuffle.
 */
export const HARD_CASE_KEY_ORDER = [
	"id",
	"input",
	"locale",
	"country",
	"class",
	"fstReach",
	"probeSurface",
	"popBias",
	"impBias",
	"probeTag",
	"expectPlaceID",
	"expectPlaceName",
	"expectLat",
	"expectLon",
	"expectToleranceM",
	"source",
	"addedAt",
	"bugRef",
	"note",
] as const satisfies readonly (keyof HardCase)[]

/**
 * The number of fields a coordinate assertion is made of; the refinement below accepts 0 or all 3.
 */
const COORDINATE_ASSERTION_FIELDS = 3

/**
 * The runtime shadow: `strictObject` with the coordinate triple refined all-or-none,
 * so a typo'd `expectLon` reads as absence rather than as "coordinate not asserted".
 */
export const HardCaseSchema = zod
	.strictObject({
		id: zod.string().min(1),
		input: zod.string().min(1),
		locale: zod.string().min(1),
		country: zod.string().length(2),
		class: zod.enum(HARD_CASE_CLASSES),
		fstReach: zod.enum(FST_REACH),
		probeSurface: zod.string().min(1),
		popBias: zod.number().min(0),
		impBias: zod.number().min(0),
		probeTag: zod.string().min(1),
		expectPlaceID: zod.string().optional(),
		expectPlaceName: zod.string().optional(),
		expectLat: zod.number().optional(),
		expectLon: zod.number().optional(),
		expectToleranceM: zod.number().positive().optional(),
		source: zod.string().min(1),
		addedAt: zod.string().min(1),
		bugRef: zod.string().optional(),
		note: zod.string().optional(),
	})
	.refine(
		(c) => {
			const present = [c.expectLat, c.expectLon, c.expectToleranceM].filter((v) => v !== undefined).length

			return present === 0 || present === COORDINATE_ASSERTION_FIELDS
		},
		{
			message:
				"expectLat / expectLon / expectToleranceM are all-or-nothing — a coordinate without a declared tolerance would be graded against a bar nobody chose",
		}
	)

/**
 * The compile-time bridge: add a field to one of {@linkcode HardCase} /
 * {@linkcode HardCaseSchema} and not the other, and `tsc` stops here.
 */
export const SCHEMA_MATCHES_TYPE = true satisfies SameShape<zod.infer<typeof HardCaseSchema>, HardCase>

/**
 * The third leg: {@linkcode HARD_CASE_KEY_ORDER} must list every key rather than merely valid ones.
 */
export const KEY_ORDER_IS_EXHAUSTIVE = true satisfies MutuallyAssignable<
	(typeof HARD_CASE_KEY_ORDER)[number],
	keyof HardCase
>

// Probe the directory rather than the board file: the builder resolves this constant before the file
// exists, and a file-existence probe would send the first build to the compiled-tree fallback.
/**
 * The committed board, named from the package root — tsc emits no `.jsonl` into `out/`.
 */
export const HARD_CASE_BOARD_PATH: string = resolvePackagePath(
	"mailwoman",
	"lib",
	"eval-harness",
	"fixtures",
	"hard-case-board.jsonl"
)

/**
 * Re-key a case into {@linkcode HARD_CASE_KEY_ORDER}, dropping absent optionals — used by any emitter
 * so the board's content hash is a function of content rather than of literal ordering.
 */
export function canonicalizeHardCase(c: HardCase): HardCase {
	const out: Partial<HardCase> = {}

	for (const key of HARD_CASE_KEY_ORDER) {
		const value = c[key]

		// `Object.assign` rather than `out[key] = value`: a dynamic key widens the write
		// target to the intersection of every field type, which no value satisfies.
		if (value !== undefined) {
			Object.assign(out, { [key]: value })
		}
	}

	return out as HardCase
}

/**
 * Load and validate the board, ordered by `id` ascending so a hand-appended
 * row cannot change what the board is.
 *
 * @throws On the first invalid row with its 1-based line number rather than silently
 * dropping it and under-reporting the board's size.
 */
export async function loadHardCaseBoard(path: string = HARD_CASE_BOARD_PATH): Promise<HardCase[]> {
	const cases: HardCase[] = []
	const ids = new Set<string>()
	let index = 0

	for await (const row of JSONSpliterator.fromAsync<unknown>(path)) {
		index++
		const parsed = HardCaseSchema.safeParse(row)

		if (!parsed.success) {
			throw new Error(
				`${path}:${index} — invalid hard-case row: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`
			)
		}

		if (ids.has(parsed.data.id)) {
			throw new Error(`${path}:${index} — duplicate case id "${parsed.data.id}"`)
		}

		ids.add(parsed.data.id)
		cases.push(parsed.data)
	}

	return cases.toSorted((a, b) => a.id.localeCompare(b.id))
}
