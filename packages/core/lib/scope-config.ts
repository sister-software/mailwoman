/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Reads `scope.config.json`, which lists the countries in each locale tier and the extra countries where the graded
 *   arc blocks a regression.
 *
 *   The config holds membership only. The evidence for each tier lives in `docs/engineering/scope.mdx`, and the
 *   `repo-health` `locale-scope` check fails when the two disagree.
 */

import type { PathBuilderLike } from "path-ts"

import { readLocalJSONFile } from "#fs/readers"
import { repoRootPathBuilder } from "#paths"

/**
 * The tier keys, as numbered in `scope.mdx`.
 * They are strings because JSON object keys are strings.
 */
export const SCOPE_TIER_KEYS = ["1", "2", "3", "4", "5"] as const

/**
 * One of the {@link SCOPE_TIER_KEYS}.
 */
export type ScopeTierKey = (typeof SCOPE_TIER_KEYS)[number]

/**
 * The parsed `scope.config.json`.
 *
 * Keys that start with `$` hold comments and are skipped.
 * Each `Record<string, string>` maps a country code to the reason for its entry.
 *
 * The `locale-scope` check validates those reasons, so this reader accepts empty ones.
 */
export interface ScopeConfig {
	tiers: Record<string, string[]>
	/**
	 * Maps each country outside tier 1 where the arc blocks a regression to the reason.
	 * Tier-1 countries need no entry.
	 */
	dRuleProtected: Record<string, string>
	/**
	 * Maps each shipping locale's country that belongs to no tier to the reason.
	 */
	untieredShippingLocales: Record<string, string>
	/**
	 * Maps each weights-family ID to the training config that produced its shipped model.
	 */
	trainingConfigs: Record<string, ShippedTrainingConfig>
}

/**
 * The training config behind one shipped model.
 *
 * The config's `country_weights` block decides which countries the model admits,
 * and coverage reports read it.
 */
export interface ShippedTrainingConfig {
	/**
	 * The repo-relative path to a config under `corpus-python/src/mailwoman_train/configs`.
	 */
	config: string
	/**
	 * The package that ships the `model.onnx` this config produced.
	 */
	graphPackage: string
	/**
	 * The `model-card.json` field that the path was copied from.
	 *
	 * The model cards use different fields for the current version.
	 */
	readFrom: string
}

/**
 * Reads `scope.config.json` from a repository root, which defaults to this checkout.
 */
export async function readScopeConfig(repoRoot: PathBuilderLike = repoRootPathBuilder()): Promise<ScopeConfig> {
	return readLocalJSONFile<ScopeConfig>(repoRoot, "scope.config.json")
}

/**
 * Returns every country in any tier.
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
 * Returns the training config for one weights family.
 *
 * @throws When the family has no entry.
 * Falling back to another family's config would report the wrong model's admissions.
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
 * Returns every family's training config, sorted by family ID.
 *
 * Each config covers one model.
 * The countries admitted across all shipped models are the union over these configs.
 */
export function shippedTrainingConfigs(scope: ScopeConfig): Array<ShippedTrainingConfig & { family: string }> {
	return Object.entries(scope.trainingConfigs ?? {})
		.filter(([family]) => !family.startsWith("$"))
		.map(([family, entry]) => ({ family, ...entry }))
		.toSorted((left, right) => left.family.localeCompare(right.family))
}

/**
 * A country where the D-rule blocks a regression, with the reason.
 * The arc prints the reason when it reports a D-rule block.
 */
export interface ProtectedCountry {
	country: string
	reason: string
}

/**
 * Returns the countries that a default-on change must not regress: all of tier
 * 1 plus the `dRuleProtected` entries.
 *
 * The result is sorted by country code so the output is stable across runs.
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
