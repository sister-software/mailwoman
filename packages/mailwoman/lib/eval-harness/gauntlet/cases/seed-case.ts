/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The per-case contract for the curated regression corpus — the TS interface, the zod schema the JSONL
 *   rows are validated against on load, and the compile-time bridge that keeps the two from drifting.
 *
 *   `SeedCase` is the SOURCE OF TRUTH; {@linkcode SeedCaseSchema} is its runtime shadow. The three `satisfies`
 *   bridges at the bottom fail `tsc` if a field reaches one and not the other, or never reaches
 *   {@linkcode SEED_CASE_KEY_ORDER}. That is the Database-interface/`createTable` idiom from AGENTS.md applied
 *   to a file format instead of a table — and, as `SameShape`'s docstring records, the obvious one-line version
 *   of it does not work.
 *
 *   The schema is STRICT: an unknown key in a JSONL row is an error, not ignored. A typo'd `expectLon` that
 *   parsed as "coordinate not asserted" is exactly the input-tail defect this file exists to make loud.
 */

import zod from "zod"

import type { AddressKind, CaseStatus, ResolutionTier } from "#eval-harness/gauntlet/schema"
import type { MutuallyAssignable, SameShape } from "#eval-harness/shape-assertions"

/**
 * One row of the curated regression corpus, as committed under `cases/<cc>/*.jsonl`.
 *
 * The field ORDER here is required twice over: {@linkcode SEED_CASE_KEY_ORDER} mirrors it (so every emitted JSONL row
 * keys identically and a diff shows content changes, never a re-shuffle), and the migration that produced the corpus
 * keyed its rows by it.
 */
export interface SeedCase {
	id: string
	input: string
	source: string
	addressKind: AddressKind
	country: string
	status: CaseStatus
	/**
	 * Optional resolver country prior (ISO-3166 alpha-2), forwarded as geocodeAddress's `defaultCountry`.
	 */
	defaultCountry?: string
	/**
	 * The CLI locale this row runs under (`en-NZ`); the runner derives the weights overlay from its region subtag,
	 * mirroring production's locale-hint routing. A LOCALE HINT, never a country constraint — `country` above stays the
	 * TRUTH's country, which for a locale row can differ (`Paris` under `en-US` is an FR row run with the US overlay).
	 * See #1585's contract.
	 */
	locale?: string
	/**
	 * Asserted admin/parse fields, when relevant — `{ country?, region?, locality? }` (matched case-insensitively).
	 */
	expectComponents?: Record<string, string>
	/**
	 * OPT-IN multi-script rendering contract, per component key — `{ venue: ["Gandantegchinlen Monastery",
	 * "Гандантэгчинлэн хийд"] }`. For a listed key the grader asserts that `scriptRenderings(got)` contains EVERY listed
	 * rendering (case-folded), and the same key in {@linkcode expectComponents} is superseded — see `check-case.ts`'s
	 * component check. Only for a row whose INPUT genuinely carries a span in two or more scripts; every list must be
	 * non-empty (the schema refuses an empty one).
	 */
	expectComponentRenderings?: Record<string, string[]>
	expectPlaceID?: string
	expectPlaceName?: string
	expectLat?: number
	expectLon?: number
	/**
	 * Great-circle tolerance (m). Defaults at runtime when absent.
	 */
	expectToleranceM?: number
	expectTier?: ResolutionTier
	/**
	 * True = the expected outcome is NO COORDINATE: the resolver abstains rather than answering, and any resolved
	 * coordinate FAILS the row. Mutually exclusive with `expectLat`/`expectLon` (the schema refuses the combination). The
	 * #1585 fuzzy-scope contract: a scoped-empty typo correction abstains instead of falling through world-fuzzy; such a
	 * row is re-pinned to real coordinates once coverage arrives (its note names the artifact).
	 */
	expectAbstain?: boolean
	addedAt: string
	bugRef?: string
	note?: string
	/**
	 * ABLATION ONLY: hand-pin the graceful-degradation rung this row's deletions should reach, per deleted component — `{
	 * country: "region" }`, `{ region: "abstain" }`. Values are `abstain`, `base`, or a WOF placetype. Absent = the
	 * ablation layer's DERIVED ladder decides, which is the default and should stay the common case. See `schema.ts`'s
	 * `ablation_expect` for the two classes (territories, dual-role places) this exists for.
	 */
	ablationExpect?: Record<string, string>
}

/**
 * The canonical key order for an emitted JSONL row — {@linkcode SeedCase}'s declaration order.
 *
 * Emission re-keys through this rather than trusting object literal order, because the corpus was authored by hand over
 * ~40 batches and the literals are not consistently ordered. Re-keying makes a `git diff` of the corpus mean
 * something.
 */
export const SEED_CASE_KEY_ORDER = [
	"id",
	"input",
	"source",
	"addressKind",
	"country",
	"status",
	"defaultCountry",
	"locale",
	"expectComponents",
	"expectComponentRenderings",
	"expectPlaceID",
	"expectPlaceName",
	"expectLat",
	"expectLon",
	"expectToleranceM",
	"expectTier",
	"expectAbstain",
	"addedAt",
	"bugRef",
	"note",
	"ablationExpect",
] as const satisfies readonly (keyof SeedCase)[]

/**
 * The runtime shadow of {@linkcode SeedCase}, applied per JSONL row on load.
 *
 * `strictObject`, not `object` — see the file header.
 */
export const SeedCaseSchema = zod.strictObject({
	id: zod.string().min(1),
	input: zod.string().min(1),
	source: zod.string().min(1),
	addressKind: zod.string().min(1),
	country: zod.string().min(1),
	status: zod.enum(["pass", "known_fail", "improvement_target"]),
	defaultCountry: zod.string().optional(),
	locale: zod
		.string()
		.regex(/^[a-z]{2}-[A-Z]{2}$/)
		.optional(),
	expectComponents: zod.record(zod.string(), zod.string()).optional(),
	// Non-empty string arrays only: an empty rendering list would assert nothing while looking asserted, and a
	// non-array value is the `expectComponents` shape filed under the wrong key.
	expectComponentRenderings: zod.record(zod.string(), zod.array(zod.string().min(1)).min(1)).optional(),
	expectPlaceID: zod.string().optional(),
	expectPlaceName: zod.string().optional(),
	expectLat: zod.number().optional(),
	expectLon: zod.number().optional(),
	expectToleranceM: zod.number().optional(),
	expectTier: zod.enum(["address_point", "interpolated", "street", "admin", "venue", "plus_code"]).optional(),
	expectAbstain: zod.boolean().optional(),
	addedAt: zod.string().min(1),
	bugRef: zod.string().optional(),
	note: zod.string().optional(),
	ablationExpect: zod.record(zod.string(), zod.string()).optional(),
})

/**
 * The compile-time bridge. If you add a field to {@linkcode SeedCase} and not to {@linkcode SeedCaseSchema} (or the other
 * way round), this line is where `tsc` stops you — `true satisfies never` does not compile.
 */
export const SCHEMA_MATCHES_TYPE = true satisfies SameShape<zod.infer<typeof SeedCaseSchema>, SeedCase>

/**
 * The third leg: {@linkcode SEED_CASE_KEY_ORDER} must list EVERY key, not merely valid ones.
 *
 * Its `satisfies readonly (keyof SeedCase)[]` checks membership only, so a new field that never reaches the array would
 * be silently dropped from every emitted row and from the content hash. This fails instead.
 */
export const KEY_ORDER_IS_EXHAUSTIVE = true satisfies MutuallyAssignable<
	(typeof SEED_CASE_KEY_ORDER)[number],
	keyof SeedCase
>

/**
 * Re-key a case into {@linkcode SEED_CASE_KEY_ORDER}, dropping absent optionals.
 *
 * Used by the emitter and by the corpus content hash, so the hash is a function of CONTENT and not of how a given
 * authoring session happened to order its literals.
 */
export function canonicalizeSeedCase(c: SeedCase): SeedCase {
	const out: Partial<SeedCase> = {}

	for (const key of SEED_CASE_KEY_ORDER) {
		const value = c[key]

		// `Object.assign` rather than `out[key] = value`: a dynamic key widens the write target to the intersection of
		// every field type, which nothing satisfies. The accumulator keeps its own type either way.
		if (value !== undefined) {
			Object.assign(out, { [key]: value })
		}
	}

	return out as SeedCase
}
