/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Compare parsed `region` and `country` qualifiers with the winning candidate's resolver ancestry. This report is
 *   observational only; it does not affect ranking or selection.
 *
 *   Each component is `confirmed`, `contradicted`, `unstated`, or `unverifiable`. Name comparisons use the shared
 *   locality fold, plus codex mappings for countries and supported subdivisions. Cross-language aliases are not
 *   inferred. Missing ancestry remains `unverifiable` rather than being treated as agreement or contradiction.
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
 * Per-component verdicts.
 *
 * Both fields are present when a winner exists; no winner omits the report.
 */
export interface AdminCoherenceReport {
	region: AdminCoherenceVerdict
	country: AdminCoherenceVerdict
}

/**
 * Parsed `region` and `country` qualifiers.
 * Blank values are treated as absent.
 */
export interface ParsedAdminQualifiers {
	region?: string | undefined
	country?: string | undefined
}

/**
 * Resolver ancestry entry, structurally matching the fields used from `Ancestor`.
 */
interface AdminAncestor {
	placetype: string
	name: string
}

/**
 * Winning candidate fields used for coherence: component tag, country code, and optional ancestry.
 */
export interface AdminCoherenceWinner {
	tag: string
	countryCode?: string | undefined
	ancestry?: readonly AdminAncestor[] | undefined
}

/**
 * Normalize names with the same fold used to build candidate `name_key` values.
 */
function foldKey(name: string): string {
	return normalizeLocalityForKey(name)
}

/**
 * Expand a recognized country into folded canonical names, surface forms, and an ISO-2 key.
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
 * Build country evidence keys from the resolver country stamp and country ancestors.
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

	// A region winner confirms its own region qualifier.
	if (winner.tag === "region") return "confirmed"

	const regionAncestors = (winner.ancestry ?? []).filter((a) => REGION_CLASS_PLACETYPES.has(a.placetype))
	const iso = winner.countryCode?.trim().toUpperCase() || undefined
	const parsedKeys = regionKeys(parsed, iso)

	for (const ancestor of regionAncestors) {
		if (intersects(parsedKeys, regionKeys(ancestor.name, iso))) return "confirmed"
	}

	// A country name may be parsed into the region slot; country evidence can confirm that qualifier.
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
 * Compare parsed qualifiers with the winning candidate.
 * This function is pure and performs no lookups.
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
 * Resolved-tree fields used by the adapter, declared locally to avoid importing the decoder.
 */
export interface AdminCoherenceSourceNode {
	tag: string
	value: string
	metadata?: Record<string, unknown> | undefined
}

/**
 * Build the report fragment from parsed qualifiers and a resolved winner.
 *
 * Use the fallback winner when no admin pick exists; omit the field when neither winner exists.
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
			// Missing ancestry is reported as `unverifiable`.
			ancestry: picked.metadata?.["ancestors"] as readonly AdminAncestor[] | undefined,
		}
	)

	return { admin_coherence: report }
}

/**
 * Tree node shape used by the forked-entity adapter, without a decoder dependency.
 */
export interface AdminCoherenceTreeNode extends AdminCoherenceSourceNode {
	children: readonly AdminCoherenceTreeNode[]
}

/**
 * Build coherence for a forked-entity answer.
 *
 * The entity has a country but no ancestry, so region checks may be `unverifiable`.
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
