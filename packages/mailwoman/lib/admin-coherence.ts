/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Compares parsed `region` and `country` qualifiers with the winning candidate's resolver ancestry.
 *   The report is informational and does not affect ranking or selection.
 *
 *   Name comparison uses the shared locality fold plus codex mappings for countries and supported
 *   subdivisions. It does not infer cross-language aliases. A qualifier with no ancestry to compare
 *   against is `unverifiable`.
 */

import { countrySurfaceForms, ISO2_TO_NAME, matchCountry } from "@mailwoman/codex/country"
import { walkNodes } from "@mailwoman/core/decoder"
import { REGION_CLASS_PLACETYPES, regionKeys } from "@mailwoman/resolver-wof-sqlite/region-keys"
import { normalizeLocalityForKey } from "@mailwoman/resolver-wof-sqlite/street"

/**
 * Verdict for one parsed qualifier.
 */
type AdminCoherenceVerdict = "confirmed" | "contradicted" | "unstated" | "unverifiable"

/**
 * Verdicts for the parsed `region` and `country` qualifiers.
 */
export interface AdminCoherenceReport {
	region: AdminCoherenceVerdict
	country: AdminCoherenceVerdict
}

/**
 * Parsed `region` and `country` qualifiers.
 * Blank values count as absent.
 */
export interface ParsedAdminQualifiers {
	region?: string | undefined
	country?: string | undefined
}

/**
 * The fields of a resolver `Ancestor` that the comparison reads.
 */
interface AdminAncestor {
	placetype: string
	name: string
}

/**
 * The winning candidate's tag, country code and optional ancestry.
 */
export interface AdminCoherenceWinner {
	tag: string
	countryCode?: string | undefined
	ancestry?: readonly AdminAncestor[] | undefined
}

/**
 * Folds a name the same way candidate `name_key` values are built.
 */
function foldKey(name: string): string {
	return normalizeLocalityForKey(name)
}

/**
 * Returns comparison keys for a country name: the folded input and, when codex recognizes
 * the country, its canonical name, surface forms and ISO 3166-1 alpha-2 key.
 */
function countryKeys(value: string): Set<string> {
	const keys = new Set([foldKey(value)])
	const match = matchCountry(value)

	if (match) {
		keys.add(`iso2:${match.iso2}`)

		if (match.canonical) {
			keys.add(foldKey(match.canonical))
		}

		for (const form of countrySurfaceForms(match.iso2)) {
			keys.add(foldKey(form))
		}
	}

	return keys
}

function intersects(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
	for (const key of a) {
		if (b.has(key)) return true
	}

	return false
}

/**
 * Returns country keys from the winner's country code and its country ancestors.
 */
function winnerCountryKeys(winner: AdminCoherenceWinner): Set<string> {
	const winnerKeys = new Set<string>()
	const iso = winner.countryCode?.trim().toUpperCase() || undefined

	if (iso) {
		winnerKeys.add(`iso2:${iso}`)
		winnerKeys.add(foldKey(iso))
		const canonical = ISO2_TO_NAME.get(iso)

		if (canonical) {
			winnerKeys.add(foldKey(canonical))
		}

		for (const form of countrySurfaceForms(iso)) {
			winnerKeys.add(foldKey(form))
		}
	}

	for (const ancestor of winner.ancestry ?? []) {
		if (ancestor.placetype !== "country") continue

		for (const key of countryKeys(ancestor.name)) {
			winnerKeys.add(key)
		}
	}

	return winnerKeys
}

function regionVerdict(parsedRegion: string | undefined, winner: AdminCoherenceWinner): AdminCoherenceVerdict {
	const parsed = parsedRegion?.trim()

	if (!parsed) return "unstated"

	// A winner tagged `region` is the parsed region itself.
	if (winner.tag === "region") return "confirmed"

	const regionAncestors = (winner.ancestry ?? []).filter((a) => REGION_CLASS_PLACETYPES.has(a.placetype))
	const iso = winner.countryCode?.trim().toUpperCase() || undefined
	const parsedKeys = regionKeys(parsed, iso)

	for (const ancestor of regionAncestors) {
		if (intersects(parsedKeys, regionKeys(ancestor.name, iso))) return "confirmed"
	}

	// The parser sometimes places a country name in the region slot, so country keys can confirm it.
	if (intersects(countryKeys(parsed), winnerCountryKeys(winner))) return "confirmed"

	return regionAncestors.length ? "contradicted" : "unverifiable"
}

function countryVerdict(parsedCountry: string | undefined, winner: AdminCoherenceWinner): AdminCoherenceVerdict {
	const parsed = parsedCountry?.trim()

	if (!parsed) return "unstated"

	if (winner.tag === "country") return "confirmed"

	const winnerKeys = winnerCountryKeys(winner)

	if (!winnerKeys.size) return "unverifiable"

	return intersects(countryKeys(parsed), winnerKeys) ? "confirmed" : "contradicted"
}

/**
 * Compares parsed qualifiers with the winning candidate without any lookups.
 */
export function assessAdminCoherence(
	parsed: ParsedAdminQualifiers,
	winner: AdminCoherenceWinner
): AdminCoherenceReport {
	return {
		region: regionVerdict(parsed.region, winner),
		country: countryVerdict(parsed.country, winner),
	}
}

/**
 * The resolved-tree node fields that {@link adminCoherenceField} reads.
 */
export interface AdminCoherenceSourceNode {
	tag: string
	value: string
	metadata?: Record<string, unknown> | undefined
}

/**
 * Builds the `admin_coherence` response field from the parsed nodes and the resolved winner.
 *
 * The function uses `fallbackWinner` when `winner` is absent.
 * It returns an empty object when both are absent.
 */
export function adminCoherenceField(
	nodes: readonly AdminCoherenceSourceNode[],
	winner: AdminCoherenceSourceNode | undefined,
	fallbackWinner: AdminCoherenceSourceNode | undefined
): { admin_coherence?: AdminCoherenceReport } {
	const picked = winner ?? fallbackWinner

	if (!picked) return {}

	const report = assessAdminCoherence(
		{
			region: nodes.find((n) => n.tag === "region")?.value?.trim() || undefined,
			country: nodes.find((n) => n.tag === "country")?.value?.trim() || undefined,
		},
		{
			tag: picked.tag,
			countryCode: (picked.metadata?.["resolver_country"] as string | undefined)?.trim() || undefined,
			ancestry: picked.metadata?.["ancestors"] as readonly AdminAncestor[] | undefined,
		}
	)

	return { admin_coherence: report }
}

/**
 * A resolved-tree node with children, as read by {@link forkedEntityCoherenceField}.
 */
export interface AdminCoherenceTreeNode extends AdminCoherenceSourceNode {
	children: readonly AdminCoherenceTreeNode[]
}

/**
 * Builds the `admin_coherence` field for a forked-entity answer.
 *
 * The entity has a country but no ancestry, so a parsed region is usually `unverifiable`.
 */
export function forkedEntityCoherenceField(
	roots: readonly AdminCoherenceTreeNode[],
	entity: { name: string; country: string }
): { admin_coherence?: AdminCoherenceReport } {
	const nodes: AdminCoherenceSourceNode[] = [...walkNodes(roots)].map((n) => ({
		tag: n.tag,
		value: n.value,
		metadata: n.metadata,
	}))

	return adminCoherenceField(
		nodes,
		{ tag: "venue", value: entity.name, metadata: { resolver_country: entity.country } },
		undefined
	)
}
