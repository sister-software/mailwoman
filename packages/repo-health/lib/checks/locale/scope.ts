/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { readReleaseConfig, shippingLocales } from "@mailwoman/core/release-config"
import { readScopeConfig, SCOPE_TIER_KEYS, tieredCountries } from "@mailwoman/core/scope-config"
import { extractDelimited } from "@mailwoman/core/scripting/arguments"
import { resolvePath } from "path-ts"

import { type Diagnostic, DiagnosticSeverity, type RepoCheck } from "#check"

const DECLARATION = "docs/engineering/SCOPE.mdx"
const REGISTER = "scope.config.json"

const TIER_ROW = /^\|\s*\*\*(\d)\s/

const COUNTRY_CODE = /^[A-Z]{2}$/

/**
 * Parses the tier table in `SCOPE.mdx` into a map from tier number to the country codes listed in that tier.
 *
 * A country can appear in more than one tier, so the map must not be inverted to look up a country's tier.
 */
export function declaredTiers(markdown: string): Map<string, string[]> {
	const tiers = new Map<string, string[]>()

	// oxlint-disable-next-line mailwoman/prefer-spliterator -- one declaration page, read whole and bounded
	for (const line of markdown.split("\n")) {
		const match = TIER_ROW.exec(line)

		if (!match?.[1]) continue

		const cells = line.split("|")
		const locales = cells[2]

		if (locales === undefined) continue

		tiers.set(
			match[1],
			extractDelimited(locales).filter((entry) => COUNTRY_CODE.test(entry))
		)
	}

	return tiers
}

function difference(left: readonly string[], right: readonly string[]): string[] {
	const held = new Set(right)

	return left.filter((entry) => !held.has(entry)).toSorted()
}

/**
 * Checks that `scope.config.json` matches the `SCOPE.mdx` tier table, that every shipping locale
 * is tiered or has a stated reason, and that the reason lists hold no empty or stale entries.
 */
export const localeScopeCheck: RepoCheck = {
	id: "locale-scope",
	description: "scope.config.json agrees with SCOPE.mdx's tier table, and every shipping locale is placed in it.",
	async run(context) {
		const scope = await readScopeConfig(context.repoRoot)
		const declared = declaredTiers(await readLocalTextFile(resolvePath(context.repoRoot, DECLARATION)))
		const diagnostics: Diagnostic[] = []

		if (declared.size < SCOPE_TIER_KEYS.length) {
			diagnostics.push({
				severity: DiagnosticSeverity.Error,
				message: `parsed ${declared.size} tier rows out of the declaration; ${SCOPE_TIER_KEYS.length} are expected, so the parser matched nothing and every comparison below is vacuous`,
				file: DECLARATION,
			})

			return diagnostics
		}

		for (const tier of SCOPE_TIER_KEYS) {
			const inDoc = declared.get(tier) ?? []
			const inRegister = scope.tiers[tier] ?? []

			for (const country of difference(inDoc, inRegister)) {
				diagnostics.push({
					severity: DiagnosticSeverity.Error,
					message: `tier ${tier} holds ${country} in the declaration and not in the register`,
					file: REGISTER,
				})
			}

			for (const country of difference(inRegister, inDoc)) {
				diagnostics.push({
					severity: DiagnosticSeverity.Error,
					message: `tier ${tier} holds ${country} in the register and not in the declaration`,
					file: DECLARATION,
				})
			}
		}

		const tiered = tieredCountries(scope)
		const untiered = scope.untieredShippingLocales ?? {}

		const shipping = new Set(
			[...shippingLocales(await readReleaseConfig(context.repoRoot))]
				.map((locale) => locale.split("-")[1]?.toUpperCase())
				.filter((country): country is string => country !== undefined)
		)

		for (const country of [...shipping].toSorted()) {
			if (tiered.has(country)) continue

			if (!untiered[country]) {
				diagnostics.push({
					severity: DiagnosticSeverity.Error,
					message: `${country} ships a weights package, sits in no tier, and has no entry in untieredShippingLocales saying why`,
					file: REGISTER,
				})
			}
		}

		for (const [country, reason] of Object.entries(untiered)) {
			if (country.startsWith("$")) continue

			if (!reason) {
				diagnostics.push({
					severity: DiagnosticSeverity.Error,
					message: `untieredShippingLocales names ${country} with an empty reason; an entry is a debt with a reason someone can read, not an exemption`,
					file: REGISTER,
				})

				continue
			}

			if (tiered.has(country)) {
				diagnostics.push({
					severity: DiagnosticSeverity.Error,
					message: `untieredShippingLocales still names ${country}, which the declaration now places in a tier — remove the entry`,
					file: REGISTER,
				})
			} else if (!shipping.has(country)) {
				diagnostics.push({
					severity: DiagnosticSeverity.Error,
					message: `untieredShippingLocales names ${country}, which no longer ships a weights package — remove the entry`,
					file: REGISTER,
				})
			}
		}

		for (const [country, reason] of Object.entries(scope.dRuleProtected ?? {})) {
			if (country.startsWith("$")) continue

			if (!reason) {
				diagnostics.push({
					severity: DiagnosticSeverity.Error,
					message: `dRuleProtected names ${country} with an empty reason; the arc reports the reason at the moment it blocks, and "${country}" alone does not answer why`,
					file: REGISTER,
				})
			}

			if ((scope.tiers["1"] ?? []).includes(country)) {
				diagnostics.push({
					severity: DiagnosticSeverity.Error,
					message: `dRuleProtected names ${country}, which tier 1 already protects unconditionally — two sources for one fact is what this register replaced`,
					file: REGISTER,
				})
			}

			if (!tiered.has(country) && !shipping.has(country)) {
				diagnostics.push({
					severity: DiagnosticSeverity.Error,
					message: `dRuleProtected names ${country}, which is in no tier and ships nothing — a protection for a country the project does not cover blocks on rows that cannot exist`,
					file: REGISTER,
				})
			}
		}

		return diagnostics
	},
}
