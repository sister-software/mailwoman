/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The HARD-SLICE BOARD (ROAD_TO_V9 §3) — the curated slice that makes an FST/importance change
 *   MEASURABLE. Schema, zod shadow, and loader for `fixtures/hard-slice-board.jsonl`.
 *
 *   WHY IT EXISTS. Three arms — no FST, the shipped population-proxy FSTs, the staged real-importance
 *   set — score byte-identically on the OA board, because a well-formed address ("1600 Pennsylvania Ave
 *   NW, Washington, DC 20500") never puts the decoder in a position where a soft gazetteer bias can
 *   change the argmax. An unmeasurable change is an unshippable change (§2 R3), so this board is
 *   assembled entirely out of inputs that DO exercise the bias list: bare toponyms, comma-free
 *   fragments, and namesake confounds.
 *
 *   WHAT A ROW IS. Every row pins ONE discrimination case and declares, in the row itself, why it
 *   should discriminate: {@linkcode HardSliceCase.probeSurface} is the token whose gazetteer bias is
 *   under test, and {@linkcode HardSliceCase.popBias} / {@linkcode HardSliceCase.impBias} are that
 *   surface's MEASURED max-importance under each FST arm (see `dev-tools/probe-fst-bias.run.ts`). A row
 *   whose two biases are EQUAL is a negative control — it must not move — and one whose biases differ
 *   sharply but ties anyway is a finding about the FST's reach, not a reason to add rows.
 *
 *   THE REACH FIELD IS required, AND IT IS NOT ABOUT WHETHER BIAS APPLIES. `fst-<locale>.bin` is
 *   country-scoped (`FST_LOCALES` in `gazetteer-pipeline/fst.ts`: en-us→US, fr-fr→FR, en-gb→GB,
 *   de-de→DE), and the arm loads a binary by LOCALE, not by the answer's country. So
 *   {@linkcode HardSliceCase.fstReach} says whether the row's EXPECTED PLACE is inside the loaded
 *   gazetteer's scope:
 *
 *   - `in` — the answer is a place the FST knows, so bias can push the parse toward it.
 *   - `out` — the answer's country is not in scope, but the QUERY'S SURFACE usually still is. "Moscow"
 *       graded under en-us scores 0.3411 (population) → 0.5465 (importance) off 33 US bearers while the
 *       correct answer is in Russia. For these rows the gazetteer can only pull toward a WRONG place, so
 *       they are the arm comparison's hijack-risk population and are reported separately.
 *
 *   Reading `out` as "no bias applies" is the trap this field exists to prevent, and the builder's first
 *   cut fell into it by DECLARING `popBias: 0` for every `out` row instead of measuring. Both fields are
 *   measured for every row, always; a zero here means the FST accepted nothing for that surface, which is
 *   a fact about the gazetteer rather than a default.
 *
 *   MEANING OF ZERO, ON TOLERANCES. A coordinate assertion is all-or-nothing and NEVER defaulted: a row
 *   either carries `expectLat` + `expectLon` + `expectToleranceM` together, or asserts no coordinate at
 *   all. {@linkcode HardSliceCaseSchema} refuses every partial combination. A silently-defaulted
 *   tolerance is a number nobody chose, and a row with a coordinate but no tolerance would inherit a bar
 *   it was never graded against — the absence of a coordinate is ABSENCE, not zero, and not a
 *   permissive default.
 *
 *   Conventions follow `gauntlet/cases/seed-case.ts` (interface as source of truth, strict zod shadow,
 *   `satisfies` bridges, canonical key order) — but this is a SEPARATE board, not gauntlet cases: it is
 *   graded through `createRuntimePipeline`, the only path an FST prior actually reaches (see the runner).
 */

import { resolvePackagePath } from "@mailwoman/core/module/resolvers"
import { JSONSpliterator } from "spliterator"
import zod from "zod"

import type { MutuallyAssignable, SameShape } from "#eval-harness/shape-assertions"

/**
 * What a row is testing. The tag is the reporting axis — per-class deltas are how an arm's effect is localized to a
 * register, rather than averaged into a single number that hides both wins and losses.
 */
export const HARD_SLICE_CLASSES = [
	/**
	 * Bare single toponym, namesake-prone, with a dominant referential answer ("Bordeaux").
	 */
	"bare_namesake",
	/**
	 * The tier-1 homonym lineage (#267/#833/#905): "Portland, ME" and friends, comma form.
	 */
	"homonym_confound",
	/**
	 * Comma-free two-toponym fragment ("Moscow Idaho") — the FST prior's design register.
	 */
	"comma_free",
	/**
	 * The comma-bearing control for a `comma_free` row: same truth, punctuation restored.
	 */
	"comma_control",
	/**
	 * Encyclopedic importance and population disagree about which bearer leads (Saint-Denis).
	 */
	"wiki_pop_conflict",
	/**
	 * A country-distinctive addressing structure from the 2026-08-05 sweep's highest-hit class.
	 */
	"country_structure",
	/**
	 * A toponym in street-head position that must NOT be pulled to locality (#1142).
	 */
	"street_head_control",
	/**
	 * A sweep namesake row whose country no FST covers — pins the reach limit itself.
	 */
	"fst_out_of_reach",
] as const

export type HardSliceClass = (typeof HARD_SLICE_CLASSES)[number]

/**
 * Whether this row's country is inside the shipped FST country scope. See the file header — a row marked `out` is
 * EXPECTED to tie across arms, and its tie is evidence about coverage rather than about importance.
 */
export const FST_REACH = ["in", "out"] as const

export type FSTReach = (typeof FST_REACH)[number]

/**
 * One row of the hard-slice board.
 *
 * Field order is required: {@linkcode HARD_SLICE_KEY_ORDER} mirrors it so every emitted row keys identically and a diff
 * shows content, never a re-shuffle.
 */
export interface HardSliceCase {
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
	class: HardSliceClass
	fstReach: FSTReach
	/**
	 * The token whose gazetteer bias is under test — the reason this row is on the board.
	 */
	probeSurface: string
	/**
	 * MEASURED `max(importance)` for {@linkcode probeSurface} under the shipped population-proxy FST, on the BIO tag named
	 * by {@linkcode probeTag}. Recorded so a reader can tell a tie caused by "no bias difference" from a tie caused by
	 * "bias difference the decoder ignored".
	 */
	popBias: number
	/**
	 * MEASURED `max(importance)` for the same surface under the staged real-importance FST.
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
	 * Great-circle tolerance (m). NEVER defaulted — see the file header's meaning-of-zero note.
	 */
	expectToleranceM?: number
	source: string
	addedAt: string
	bugRef?: string
	note?: string
}

/**
 * Canonical key order — {@linkcode HardSliceCase}'s declaration order. Emission re-keys through this so the board's diff
 * means something.
 */
export const HARD_SLICE_KEY_ORDER = [
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
] as const satisfies readonly (keyof HardSliceCase)[]

/**
 * How many fields a coordinate assertion is made of — `expectLat`, `expectLon`, `expectToleranceM`. The refinement
 * below accepts 0 of them or all 3, never a partial, so this is the "all" side of that rule.
 */
const COORDINATE_ASSERTION_FIELDS = 3

/**
 * The runtime shadow. `strictObject`, and the coordinate triple is refined as ALL-OR-NOTHING: a typo'd `expectLon` that
 * silently read as "coordinate not asserted" is exactly the input-tail defect this board exists to make loud.
 */
export const HardSliceCaseSchema = zod
	.strictObject({
		id: zod.string().min(1),
		input: zod.string().min(1),
		locale: zod.string().min(1),
		country: zod.string().length(2),
		class: zod.enum(HARD_SLICE_CLASSES),
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
 * The compile-time bridge: add a field to one of {@linkcode HardSliceCase} / {@linkcode HardSliceCaseSchema} and not the
 * other, and `tsc` stops here.
 */
export const SCHEMA_MATCHES_TYPE = true satisfies SameShape<zod.infer<typeof HardSliceCaseSchema>, HardSliceCase>

/**
 * The third leg: {@linkcode HARD_SLICE_KEY_ORDER} must list EVERY key, not merely valid ones.
 */
export const KEY_ORDER_IS_EXHAUSTIVE = true satisfies MutuallyAssignable<
	(typeof HARD_SLICE_KEY_ORDER)[number],
	keyof HardSliceCase
>

// Probe the DIRECTORY, not the board file: the builder that WRITES the board resolves this constant
// before the file exists, and a file-existence probe would send the first build to the compiled-tree
// fallback (which resolves outside the workspace). The fixtures dir is committed, so it is the stable
// discriminator between source and compiled trees.
/**
 * The committed board, named from the package root — tsc emits no `.jsonl` into `out/`.
 */
export const HARD_SLICE_BOARD_PATH: string = resolvePackagePath(
	"mailwoman",
	"eval-harness",
	"fixtures",
	"hard-slice-board.jsonl"
)

/**
 * Re-key a case into {@linkcode HARD_SLICE_KEY_ORDER}, dropping absent optionals — used by any emitter so the board's
 * content hash is a function of CONTENT, not of literal ordering.
 */
export function canonicalizeHardSliceCase(c: HardSliceCase): HardSliceCase {
	const out: Partial<HardSliceCase> = {}

	for (const key of HARD_SLICE_KEY_ORDER) {
		const value = c[key]

		// `Object.assign` rather than `out[key] = value`: a dynamic key widens the write target to the intersection of
		// every field type, which nothing satisfies. The accumulator keeps its own type either way.
		if (value !== undefined) {
			Object.assign(out, { [key]: value })
		}
	}

	return out as HardSliceCase
}

/**
 * Load + validate the board. Order is DEFINED (by `id`, ascending), so a hand-appended row cannot change what the board
 * IS — only what a text diff looks like.
 *
 * Throws on the first invalid row with its 1-based line number: a board that silently drops a malformed row would
 * under-report its own size, and the arm comparison would be run on a set nobody declared.
 */
export async function loadHardSliceBoard(path: string = HARD_SLICE_BOARD_PATH): Promise<HardSliceCase[]> {
	const rows = await Array.fromAsync(JSONSpliterator.fromAsync<unknown>(path))
	const cases: HardSliceCase[] = []
	const ids = new Set<string>()

	for (const [index, row] of rows.entries()) {
		const parsed = HardSliceCaseSchema.safeParse(row)

		if (!parsed.success) {
			throw new Error(
				`${path}:${index + 1} — invalid hard-slice row: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`
			)
		}

		if (ids.has(parsed.data.id)) {
			throw new Error(`${path}:${index + 1} — duplicate case id "${parsed.data.id}"`)
		}

		ids.add(parsed.data.id)
		cases.push(parsed.data)
	}

	return cases.toSorted((a, b) => a.id.localeCompare(b.id))
}
