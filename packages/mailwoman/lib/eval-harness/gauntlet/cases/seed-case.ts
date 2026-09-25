/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Regression-corpus case type, its zod schema, and compile-time checks that keep the type, the schema and
 *   {@linkcode SEED_CASE_KEY_ORDER} in agreement.
 */

import { stringifyJSON } from "@mailwoman/core/json"
import zod from "zod"

import type { AddressKind, CaseStatus, GauntletCaseTable, ResolutionTier } from "#eval-harness/gauntlet/schema"
import type { MutuallyAssignable, SameShape } from "#eval-harness/shape-assertions"

/**
 * One row of the regression corpus, as committed under `cases/<cc>/*.jsonl`.
 *
 * The field order must match {@linkcode SEED_CASE_KEY_ORDER}.
 */
export interface SeedCase {
	id: string
	input: string
	source: string
	addressKind: AddressKind
	country: string
	status: CaseStatus
	/**
	 * Resolver country prior as an ISO 3166-1 alpha-2 code.
	 * It is passed to `geocodeAddress` as `defaultCountry`.
	 */
	defaultCountry?: string
	/**
	 * CLI locale for the row, such as `en-NZ`.
	 *
	 * The runner picks the weights overlay from its region subtag.
	 *
	 * The locale is a hint and does not constrain the country.
	 * The `country` field keeps the expected country, so `Paris` under `en-US`
	 * is an FR row run with the US overlay.
	 */
	locale?: string
	/**
	 * Expected component values such as `country`, `region`, and `locality`.
	 * The grader compares them case-insensitively.
	 */
	expectComponents?: Record<string, string>
	/**
	 * Expected renderings per component key for input that holds a span in two or more scripts,
	 * for example `{ venue: ["Gandantegchinlen Monastery", "Гандантэгчинлэн хийд"] }`.
	 *
	 * For each listed key, the grader requires `scriptRenderings(got)` to contain
	 * every rendering after case folding.
	 * The same key in {@linkcode expectComponents} is then ignored.
	 * The schema rejects an empty list.
	 */
	expectComponentRenderings?: Record<string, string[]>
	expectPlaceID?: string
	expectPlaceName?: string
	expectLat?: number
	expectLon?: number
	/**
	 * Great-circle tolerance in meters.
	 * The runner applies a default when it is absent.
	 */
	expectToleranceM?: number
	expectTier?: ResolutionTier
	/**
	 * Whether the resolver must abstain.
	 * Any resolved coordinate fails the row.
	 *
	 * The grader rejects a row that also sets `expectLat` or `expectLon`.
	 */
	expectAbstain?: boolean
	addedAt: string
	bugRef?: string
	note?: string
	/**
	 * Hand-pinned ablation rung per deleted component, such as `{ country: "region" }`
	 * or `{ region: "abstain" }`.
	 *
	 * Values are `abstain`, `base`, or a WOF placetype.
	 * When it is absent, the derived ladder decides.
	 *
	 * The `ablation_expect` column in `schema.ts` describes the cases that need it.
	 */
	ablationExpect?: Record<string, string>
}

/**
 * Key order for emitted JSONL rows, matching {@linkcode SeedCase}'s declaration order.
 *
 * Emission re-keys each row through this list because hand-written rows do not share a key order.
 * A stable order keeps corpus diffs limited to content changes.
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
 * Runtime schema for {@linkcode SeedCase}, applied to each JSONL row on load.
 *
 * The schema is strict so that a misspelled key such as `expectLon` fails the load
 * instead of silently dropping an assertion.
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
	// An empty rendering list would assert nothing, so each list needs at least one non-empty string.
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
 * Compile-time check that {@linkcode SeedCase} and {@linkcode SeedCaseSchema} have the same fields.
 *
 * A mismatch makes the type `never`, and `tsc` rejects this line.
 */
export const SCHEMA_MATCHES_TYPE = true satisfies SameShape<zod.infer<typeof SeedCaseSchema>, SeedCase>

/**
 * Compile-time check that {@linkcode SEED_CASE_KEY_ORDER} lists every {@linkcode SeedCase} key.
 *
 * The `satisfies` clause on the array only checks that each entry is a valid key.
 * A missing key would drop that field from every emitted row and from the content hash.
 */
export const KEY_ORDER_IS_EXHAUSTIVE = true satisfies MutuallyAssignable<
	(typeof SEED_CASE_KEY_ORDER)[number],
	keyof SeedCase
>

/**
 * Returns the case with keys in {@linkcode SEED_CASE_KEY_ORDER} and undefined fields removed.
 *
 * The emitter and the corpus content hash both use it, so the hash depends only on content.
 */
export function canonicalizeSeedCase(c: SeedCase): SeedCase {
	const out: Partial<SeedCase> = {}

	for (const key of SEED_CASE_KEY_ORDER) {
		const value = c[key]

		// TypeScript types a dynamic `out[key]` write as the intersection of all field types, so `Object.assign` is used.
		if (value !== undefined) {
			Object.assign(out, { [key]: value })
		}
	}

	return out as SeedCase
}

/**
 * Converts a seed case to a `gauntlet_case` table row.
 *
 * Absent fields become `null`, and object-valued fields become JSON strings.
 *
 * The regression database builder and candidate-row grading both use this conversion,
 * so they read seed fields the same way.
 */
export function seedCaseToTableRow(c: SeedCase): GauntletCaseTable {
	return {
		id: c.id,
		input: c.input,
		source: c.source,
		address_kind: c.addressKind,
		country: c.country,
		status: c.status,
		expect_components: c.expectComponents ? stringifyJSON(c.expectComponents) : null,
		expect_component_renderings: c.expectComponentRenderings ? stringifyJSON(c.expectComponentRenderings) : null,
		expect_place_id: c.expectPlaceID ?? null,
		expect_place_name: c.expectPlaceName ?? null,
		expect_lat: c.expectLat ?? null,
		expect_lon: c.expectLon ?? null,
		expect_tolerance_m: c.expectToleranceM ?? null,
		expect_tier: c.expectTier ?? null,
		default_country: c.defaultCountry ?? null,
		added_at: c.addedAt,
		bug_ref: c.bugRef ?? null,
		note: c.note ?? null,
		ablation_expect: c.ablationExpect ? stringifyJSON(c.ablationExpect) : null,
		locale: c.locale ?? null,
		expect_abstain: c.expectAbstain ? 1 : null,
	}
}
