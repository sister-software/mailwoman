/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The `prefer-home` table: helper shapes that already have a home, and the import each re-typed copy should become, read by `oxlint.plugin.ts`.
 */

/* oxlint-disable mailwoman/prefer-home -- this file is the table the rule reads. Every constant and subcommand below
   is the signature of a helper, quoted so the rule can recognize a copy. importing the helper here would leave the
   rule with no copy to match on. */

/**
 * A helper shape that already has a home, whose `signature` is what a re-typed
 * copy looks like in the AST: a `method-chain` lists the outermost call's
 * methods innermost-first, matched as a suffix with optional literal arguments,
 * a `numeric-literal` or `string-literal` names a literal a copy cannot avoid,
 * a `descending-swap-loop` names a control shape that carries no distinctive literal,
 * and a `template-properties` names the components a template interpolates in order.
 */
export interface HelperHome {
	readonly id: string
	readonly signature:
		| { readonly kind: "method-chain"; readonly chain: readonly string[]; readonly arguments?: readonly number[] }
		| { readonly kind: "numeric-literal"; readonly values: ReadonlySet<number> }
		| { readonly kind: "string-literal"; readonly includes: readonly string[] }
		| { readonly kind: "descending-swap-loop" }
		| { readonly kind: "template-properties"; readonly properties: readonly string[] }
	readonly specifier: string
	readonly symbol: string
	readonly reason: string
}

/**
 * Every helper shape the `prefer-home` rule knows.
 */
export const HELPER_HOMES: readonly HelperHome[] = [
	{
		id: "iso-date",
		signature: { kind: "method-chain", chain: ["toISOString", "slice"], arguments: [0, 10] },
		specifier: "@mailwoman/core/utils",
		symbol: "isoDate",
		reason: "the UTC calendar date as `YYYY-MM-DD`",
	},
	{
		id: "iso-seconds",
		signature: { kind: "method-chain", chain: ["toISOString", "replace"] },
		specifier: "@mailwoman/core/utils",
		symbol: "isoSeconds (`Z` suffix) or isoSecondsUTC (`+00:00`, the Python manifest shape)",
		reason: "the UTC instant at second precision",
	},
	{
		id: "earth-radius",
		signature: { kind: "numeric-literal", values: new Set([6371, 6_371_000]) },
		specifier: "@mailwoman/spatial",
		symbol: "haversineKm (with EARTH_RADIUS beside it)",
		reason: "Earth's mean radius, and with it the great-circle distance",
	},
	{
		id: "mulberry32",
		signature: { kind: "numeric-literal", values: new Set([0x6d_2b_79_f5]) },
		specifier: "@mailwoman/core/random",
		symbol: "mulberry32",
		reason: "the mulberry32 seeded generator, whose stream every eval split and corpus sampler shares",
	},
	{
		id: "git-state",
		signature: {
			kind: "string-literal",
			includes: [
				"rev-parse HEAD",
				"rev-parse --short HEAD",
				"rev-parse --abbrev-ref HEAD",
				"status --porcelain",
				"ls-files -z",
			],
		},
		specifier: "@mailwoman/core/git",
		symbol: "gitHead, currentBranch, dirtyTrackedFiles, or trackedFiles",
		reason: "a reading of the working tree's git state",
	},
	{
		id: "lcg",
		signature: { kind: "numeric-literal", values: new Set([1_664_525, 1_013_904_223]) },
		specifier: "@mailwoman/core/random",
		symbol: "makeLcg",
		reason: "the linear congruential stream baked into shipped corpus rows",
	},
	{
		id: "glibc-lcg",
		signature: { kind: "numeric-literal", values: new Set([1_103_515_245]) },
		specifier: "@mailwoman/core/random",
		symbol: "makeGlibcLcgInt32 or makeGlibcLcgFloat64 — read their docstrings, the two are NOT the same sequence",
		reason: "glibc's LCG multiplier, which three files had each re-typed under the same name for two different streams",
	},
	{
		id: "fisher-yates",
		signature: { kind: "descending-swap-loop" },
		specifier: "@mailwoman/core/random",
		symbol: "shuffleWith (or shuffleBy, when the sampler is not a scaled float)",
		reason: "the Fisher-Yates walk, whose draw order decides which rows a seeded panel selects",
	},
	{
		id: "address-order",
		signature: { kind: "template-properties", properties: ["locality", "region", "postcode"] },
		specifier: "@mailwoman/codex/address-format",
		symbol: "formatAddressRow",
		reason:
			"the United States postal order, written as a template. Which components a country prints, in what order, " +
			"with which separators, is DATA in codex and the renderer evaluates it — a template literal prints Japan's " +
			"admin run backwards and prints a region France does not write",
	},
]
