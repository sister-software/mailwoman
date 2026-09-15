/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file `scope.config.json` and `SCOPE.mdx`'s tier table name the same countries, and every shipping locale is placed.
 *
 *   The defect this was written for is a hand-written list drifting from the table it claims to encode.
 *   `D_RULE_COUNTRIES` read `["FR", "GB", "DE"]` under a docstring saying iron rule 6 protected those locales
 *   unconditionally, while the tier table put US and FR in tier 1 — so a candidate that regressed US rows raised no
 *   D-rule reason at all. Nothing failed, because a list that does not name a country answers nothing for it and every
 *   consumer reads that as an absence rather than an error. The list is now derived from the register, and this check
 *   is what keeps the register and the declaration from becoming two lists again.
 *
 *   IT CHECKS MEMBERSHIP, NOT EVIDENCE. The table's third column is prose with citations — coordinate panels, n, issue
 *   links — and generating that from JSON would move paragraphs into a config to satisfy a parser. The doc owns the
 *   evidence; the register owns which countries each tier holds; this refuses a disagreement in either direction.
 *
 *   THE SECOND INVARIANT IS THE ONE THE FIRST CANNOT SEE. Two registers can agree with each other and both omit a
 *   country that ships. GB, IN and NZ are in that state today: three published weights packages, no tier between them,
 *   because the table was declared on 2026-07-02 and the overlays shipped after it. So a shipping locale must be
 *   tiered or named in `untieredShippingLocales` with a reason someone can read — the same posture
 *   `SANCTIONED_RELEASE_ABSENCES` takes toward a workspace held out of the release list, and for the same reason: a
 *   flag is checkable, a silence is not.
 *
 *   The register is read rather than imported: it sits at the repository root, and a package that reached it at
 *   runtime would break the moment it ran from a published tarball.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { readReleaseConfig, shippingLocales } from "@mailwoman/core/release-config"
import { readScopeConfig, SCOPE_TIER_KEYS, tieredCountries } from "@mailwoman/core/scope-config"
import { resolvePath } from "path-ts"

import { type Diagnostic, DiagnosticSeverity, type RepoCheck } from "#check"

const DECLARATION = "docs/engineering/SCOPE.mdx"
const REGISTER = "scope.config.json"

/**
 * A tier row opens with the tier number in bold, `| **1 — first-class, floor-enforced** | US, FR | …`. The em dash and
 * the label are the doc's prose and are deliberately not matched: a row renamed is not a row moved.
 */
const TIER_ROW = /^\|\s*\*\*(\d)\s/

/**
 * A country code as the table spells one. The locales cell is a comma-separated list and nothing else, so anything that
 * is not two uppercase letters in that cell is a parse failure rather than a country to skip quietly.
 */
const COUNTRY_CODE = /^[A-Z]{2}$/

/**
 * Tier number → the countries `SCOPE.mdx` places in it.
 *
 * Membership is multi-valued by design — CZ and PL hold a tier-2 and a tier-4 entry at once, because tiers 4 and 5 name
 * a delivery mechanism rather than a stronger claim — so this answers per tier and never inverts to country → tier.
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
			locales
				.split(",")
				.map((entry) => entry.trim())
				.filter((entry) => COUNTRY_CODE.test(entry))
		)
	}

	return tiers
}

function difference(left: readonly string[], right: readonly string[]): string[] {
	const held = new Set(right)

	return left.filter((entry) => !held.has(entry)).toSorted()
}

/**
 * The `locale-scope` check: one error per country the declaration and the register disagree about, one per shipping
 * locale placed in neither, and one per stale entry in either list of stated reasons.
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
