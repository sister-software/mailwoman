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
 *   reading "locales that iron rule 6 guards unconditionally", where the tier table names two and neither list knew
 *   about the other.
 *
 *   The register carries membership only. The evidence behind a tier is prose with citations and stays in
 *   `docs/engineering/scope.mdx`; `repo-health`'s `locale-scope` check refuses a disagreement between the two.
 */

import type { PathBuilderLike } from "path-ts"

import { readLocalJSONFile } from "#fs/readers"
import { repoRootPathBuilder } from "#paths"

/**
 * The declared tiers, keyed by the number scope.mdx prints. Keys are strings because JSON has no integer keys, and the
 * tier numbers are labels rather than a scale you would do arithmetic on.
 */
export const SCOPE_TIER_KEYS = ["1", "2", "3", "4", "5"] as const

export type ScopeTierKey = (typeof SCOPE_TIER_KEYS)[number]

/**
 * `scope.config.json`, as read. `$comment`-prefixed keys carry the reasoning and are ignored here. a `Record` value is
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
	/**
	 * Weights-family id → the training config that produced that family's shipped graph.
	 */
	trainingConfigs: Record<string, ShippedTrainingConfig>
}

/**
 * The training config behind one shipped model graph.
 *
 * The path is repository-relative and names a file under `corpus-python/src/mailwoman_train/configs`. Its
 * `country_weights` block is the hard admission filter every coverage report reads, so a report that reads a different
 * file reports different admissions for the same repository.
 */
export interface ShippedTrainingConfig {
	/**
	 * Repository-relative path to the config file.
	 */
	config: string
	/**
	 * The package shipping the `model.onnx` this config produced.
	 */
	graphPackage: string
	/**
	 * Which field of that package's `model-card.json` the path was read out of. Recorded because the two cards disagree
	 * about which of their own fields tracks the current version.
	 */
	readFrom: string
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
 * The training config the register names for one weights family.
 *
 * Throws when the family has no entry. A family whose config nobody recorded is a family whose admission numbers cannot
 * be produced, and answering with another family's config would report one graph's admissions under another graph's
 * name.
 */
export function shippedTrainingConfig(scope: ScopeConfig, family: string): ShippedTrainingConfig {
	const entry = scope.trainingConfigs?.[family]

	if (!entry) {
		const known = Object.keys(scope.trainingConfigs ?? {}).join(", ") || "none"

		throw new Error(
			`\`scope.config.json\` names no training config for weights family "${family}". It names: ${known}. ` +
				"Add the entry rather than reading another family's config."
		)
	}

	return entry
}

/**
 * Every family's shipped training config, ordered by family id.
 *
 * A coverage reading that wants the countries the shipped models admit reads all of these and takes the union. Reading
 * one of them alone answers for one graph: the Latin config's `country_weights` names no CJK country, and the character
 * config's names no Latin one.
 */
export function shippedTrainingConfigs(scope: ScopeConfig): Array<ShippedTrainingConfig & { family: string }> {
	return Object.entries(scope.trainingConfigs ?? {})
		.filter(([family]) => !family.startsWith("$"))
		.map(([family, entry]) => ({ family, ...entry }))
		.toSorted((left, right) => left.family.localeCompare(right.family))
}

/**
 * One country the D-rule guards, and the reason it is guarded.
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
 * The countries a default-on change may not regress: tier 1, which iron rule 6 guards unconditionally, plus every
 * country the register guards explicitly. Sorted by country code so an arc's reasons read the same on every run.
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
