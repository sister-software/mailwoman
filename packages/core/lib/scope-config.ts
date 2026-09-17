/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The typed reader of `scope.config.json`, the register that says which countries each locale tier holds and which
 *   ones the graded arc blocks on beyond iron rule 6's tier-1 floor.
 *
 *   One home, for the reason the sibling `release-config.ts` states about itself: a reader that lives outside a package
 *   is unreachable from one, which is how a package comes to hardcode what a config already names. The list this
 *   replaces was `D_RULE_COUNTRIES` in `@mailwoman/dev-mcp` — three hand-written country codes under a docstring
 *   reading "locales that iron rule 6 protects unconditionally", where the tier table names two and neither list knew
 *   about the other.
 *
 *   The register carries membership only. The evidence behind a tier is prose with citations and stays in
 *   `docs/engineering/SCOPE.mdx`; `repo-health`'s `locale-scope` check refuses a disagreement between the two.
 */

import type { PathBuilderLike } from "path-ts"

import { readLocalJSONFile } from "#fs/readers"
import { repoRootPathBuilder } from "#paths"

/**
 * The declared tiers, keyed by the number SCOPE.mdx prints. Keys are strings because JSON has no integer keys, and the
 * tier numbers are labels rather than a scale you would do arithmetic on.
 */
export const SCOPE_TIER_KEYS = ["1", "2", "3", "4", "5"] as const

export type ScopeTierKey = (typeof SCOPE_TIER_KEYS)[number]

/**
 * `scope.config.json`, as read. `$comment`-prefixed keys carry the reasoning and are ignored here; a `Record` value is
 * country code → the reason that entry exists, and an empty reason is refused by the `locale-scope` check rather than
 * by this reader, so a malformed register still parses and reports rather than throwing at every call site.
 */
export interface ScopeConfig {
	tiers: Record<string, string[]>
	/**
	 * Country code → why the arc blocks on it beyond rule 6's tier-1 floor. A tier-1 country needs no entry.
	 */
	dRuleProtected: Record<string, string>
	/**
	 * Country code → why a shipping locale sits in no tier. Each is a debt with a stated reason.
	 */
	untieredShippingLocales: Record<string, string>
}

/**
 * Read `scope.config.json` from the repository root (the checkout's, by default).
 */
export async function readScopeConfig(repoRoot: PathBuilderLike = repoRootPathBuilder()): Promise<ScopeConfig> {
	return readLocalJSONFile<ScopeConfig>(repoRoot, "scope.config.json")
}

/**
 * Every country the register places in a tier, in any tier.
 */
export function tieredCountries(scope: ScopeConfig): Set<string> {
	const countries = new Set<string>()

	for (const key of SCOPE_TIER_KEYS) {
		for (const country of scope.tiers[key] ?? []) {
			countries.add(country)
		}
	}

	return countries
}

/**
 * One country the D-rule protects, and the reason it is protected.
 *
 * The reason travels with the country because the arc reports a D-rule block at the moment a reader is deciding whether
 * to believe it, and "GB" alone does not answer "why is GB on this list". Tier-1 membership is the reason for a tier-1
 * country, so those entries say so.
 */
export interface ProtectedCountry {
	country: string
	reason: string
}

/**
 * The countries a default-on change may not regress: tier 1, which iron rule 6 protects unconditionally, plus every
 * country the register protects explicitly. Sorted by country code so an arc's reasons read the same on every run.
 */
export function dRuleCountries(scope: ScopeConfig): ProtectedCountry[] {
	const protectedCountries = new Map<string, string>()

	for (const country of scope.tiers["1"] ?? []) {
		protectedCountries.set(country, "tier 1 — iron rule 6 protects it unconditionally")
	}

	for (const [country, reason] of Object.entries(scope.dRuleProtected ?? {})) {
		if (country.startsWith("$")) continue

		protectedCountries.set(country, reason)
	}

	return [...protectedCountries]
		.map(([country, reason]) => ({ country, reason }))
		.toSorted((left, right) => left.country.localeCompare(right.country))
}
