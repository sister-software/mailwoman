/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   This module defines the regression-corpus case type and its Zod schema.
 *   Compile-time checks keep the type and schema aligned with {@linkcode SEED_CASE_KEY_ORDER}.
 */

import type { ResolutionTier } from "@mailwoman/annotations/geo"
import { stringifyJSON } from "@mailwoman/core/json"
import zod from "zod"

import type { AddressKind, CaseStatus, GauntletCaseTable } from "#eval-harness/gauntlet/schema"
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
	defaultCountry?: string
	/**
	 * CLI locale for the row, such as `en-NZ`; it selects the weights overlay from
	 * its region subtag and does not constrain `country`.
	 */
	locale?: string
	/**
	 * Expected component values, such as `country`, `region`, and `locality`,
	 * compared case-insensitively by the grader.
	 */
	expectComponents?: Record<string, string>
	/**
	 * Expected renderings per component key when the input span uses two or more scripts,
	 * such as `{ venue: ["Gandantegchinlen Monastery", "Гандантэгчинлэн хийд"] }`.
	 *
	 * The grader requires each listed rendering to appear in `scriptRenderings(got)` after case folding.
	 * A key listed here supersedes the same key in {@linkcode expectComponents}.
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
	 *
	 * Any resolved coordinate fails the row.
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
	 * The derived ladder decides when a rung is absent.
	 */
	ablationExpect?: Record<string, string>
}

/**
 * Key order for emitted JSONL rows, matching {@linkcode SeedCase}'s declaration order.
 * re-keying through this list keeps corpus diffs limited to content changes.
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
 * Runtime schema for {@linkcode SeedCase}, applied to each JSONL row on load and strict
 * so a misspelled key fails the load instead of silently dropping an assertion.
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
	// An empty rendering list would assert no rendering, so each list needs at least one non-empty string.
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
 * A mismatch makes the type `never` and `tsc` rejects this line.
 */
export const SCHEMA_MATCHES_TYPE = true satisfies SameShape<zod.infer<typeof SeedCaseSchema>, SeedCase>

/**
 * Compile-time check that {@linkcode SEED_CASE_KEY_ORDER} lists every
 * {@linkcode SeedCase} key; `satisfies` alone checks only that each entry is valid,
 * so a missing key would drop that field from every emitted row.
 */
export const KEY_ORDER_IS_EXHAUSTIVE = true satisfies MutuallyAssignable<
	(typeof SEED_CASE_KEY_ORDER)[number],
	keyof SeedCase
>

/**
 * Returns the case with keys in {@linkcode SEED_CASE_KEY_ORDER} and undefined fields removed.
 * The corpus content hash then depends only on case content.
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
 * Absent fields become `null` and object-valued fields become JSON strings.
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
