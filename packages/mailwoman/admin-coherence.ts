/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Admin-coherence verdicts (#1717 stage 1) — after a geocode resolves, compare the PARSED admin
 *   qualifiers (`region`, `country`) against what the winning candidate's resolved ancestry actually
 *   says, and report a per-component verdict. FLAG-ONLY: nothing reads these verdicts to rank,
 *   re-pick, or gate — they exist so a board run can count how often the resolver's answer ignores a
 *   qualifier the parse got right (`Weimar, Thüringen` → Weimar TX), and how often the winner
 *   carries no ancestry to check at all (the `unverifiable` count, which sizes the candidate.db
 *   ancestors-table work).
 *
 *   Per-component verdicts, never one scalar (the Google-confirmation-levels / USPS-DPV pattern):
 *
 *   - `confirmed` — the qualifier matches a winner-ancestry node of its class under the shared
 *     name fold ({@link normalizeLocalityForKey}, the same fold candidate.db's `name_key` is built
 *     with — build side and check side agree by construction), or the winner IS that qualifier's
 *     own resolution (a region-tagged winner confirms the region qualifier by identity —
 *     containment degenerates to self).
 *   - `contradicted` — the winner's ancestry HAS a node of that class and none of them fold-match
 *     the parsed value.
 *   - `unstated` — the parse produced no such qualifier. The common case, and not a problem: most
 *     queries simply don't name a region or country.
 *   - `unverifiable` — the parse produced the qualifier but the winner carries NO ancestry of that
 *     class to check against. Report it faithfully; folding it into either decided verdict would
 *     hide exactly the gap #1717 wants measured.
 *
 *   STATED BOUNDS (v1 is fold-equality only — do not read more into a verdict than this):
 *
 *   - Cross-language variant forms are NOT bridged: `Thüringen` folds to `thuringen`, the stored
 *     exonym `Thuringia` to `thuringia`, so a variant-form match the gazetteer could vouch for
 *     still reads `contradicted`. Bridging it needs a candidate.db alias probe, which would pull
 *     the SQLite lookup machinery into this pure module — deliberately skipped.
 *   - The only normalizers consulted beyond the fold are the codex tables, because they are pure
 *     and already in-house: {@link matchCountry} (surface form / alpha-2 / alpha-3 → country) and
 *     {@link matchSubdivision} (US state + CA province code ↔ name). So `IL` confirms against
 *     `Illinois` and `Deutschland` against a DE winner, but an uncurated endonym (`Alemania`)
 *     against a DE winner reads `contradicted` — the module never silently over-claims a match it
 *     cannot derive.
 *
 *   The winner's checkable ancestry at the assembly seam is thin today, on purpose reported rather
 *   than papered over: the candidate backend has no `ancestors()` table, so region-class ancestry
 *   exists only when the resolver stamped `metadata.ancestors` (WOF backend, opt-in #404), while
 *   country-class ancestry is nearly always available via the `resolver_country` stamp. Expect
 *   `region: unverifiable` to dominate on the candidate tier — that count is the finding.
 */

import { countrySurfaceForms, ISO2_TO_NAME, matchCountry, matchSubdivision } from "@mailwoman/codex/country"
import { normalizeLocalityForKey } from "@mailwoman/resolver-wof-sqlite/street-normalize"

/**
 * One admin-coherence verdict. See the module docstring for the exact meaning of each — in particular, `unverifiable`
 * is an absence-of-evidence claim about the WINNER, never about the parse.
 */
export type AdminCoherenceVerdict = "confirmed" | "contradicted" | "unstated" | "unverifiable"

/**
 * The per-component verdicts. Both members are always present when the report exists (the `intent_markers` discipline:
 * state the empty case — `unstated` IS the explicit "no qualifier" claim, so an optional member would be a second way
 * to say the same thing). The report as a whole is what's optional: absent means the geocode resolved no winner to
 * check against.
 */
export interface AdminCoherenceReport {
	region: AdminCoherenceVerdict
	country: AdminCoherenceVerdict
}

/**
 * The parsed admin qualifiers — the raw spans off the address tree's `region` / `country` nodes (the parse view, not
 * the resolved view). Empty / whitespace-only reads as absent.
 */
export interface ParsedAdminQualifiers {
	region?: string | undefined
	country?: string | undefined
}

/**
 * One link of the winner's containment lineage, as the resolver stamped it (`metadata.ancestors`, the #404 opt-in) — a
 * structural slice of `@mailwoman/core`'s `Ancestor`.
 */
export interface AdminAncestor {
	placetype: string
	name: string
}

/**
 * The winning candidate, reduced to what the check reads: its own component tag (for the self-confirmation case), the
 * resolver-stamped ISO 3166-1 alpha-2 (`resolver_country` — the one piece of country-class ancestry the candidate
 * backend always carries), and the stamped ancestor chain when a backend supplied one.
 */
export interface AdminCoherenceWinner {
	tag: string
	countryCode?: string | undefined
	ancestry?: readonly AdminAncestor[] | undefined
}

/**
 * The ancestry placetypes that answer for a parsed `region` qualifier — WOF's admin band between country and locality.
 * Deliberately the whole band: a qualifier stated at any grain ("Lancashire", a ceremonial county; "Thüringen", a Land)
 * may confirm against whichever level the backend stored, and `contradicted` requires the entire band to miss, so
 * widening the band only ever makes the check more conservative.
 */
const REGION_CLASS_PLACETYPES: ReadonlySet<string> = new Set(["region", "macroregion", "county", "macrocounty"])

/**
 * Fold both sides of every name comparison through the shared candidate.db `name_key` normalizer — one function, both
 * sides, so the check can never disagree with the index it's checking against.
 */
function foldKey(name: string): string {
	return normalizeLocalityForKey(name)
}

/**
 * The comparable keys a region string expands to: its own fold, plus — when the codex subdivision table recognizes it
 * (US states + CA provinces) — the folds of the canonical name and the ISO 3166-2 code, so `IL` and `Illinois` land in
 * the same key set from either side.
 */
function regionKeys(value: string): Set<string> {
	const keys = new Set([foldKey(value)])
	const subdivision = matchSubdivision(value)

	if (subdivision) {
		keys.add(foldKey(subdivision.name))
		keys.add(foldKey(subdivision.code))
	}

	return keys
}

/**
 * The comparable keys a country-class value expands to: its own fold, plus — when {@link matchCountry} recognizes it —
 * an `iso2:` channel key and the folds of the canonical name and curated surface forms, so `Deutschland`, `DEU`, `DE`
 * and `Germany` all meet in one key set regardless of which side spelled which.
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

function regionVerdict(parsedRegion: string | undefined, winner: AdminCoherenceWinner): AdminCoherenceVerdict {
	const parsed = parsedRegion?.trim()

	if (!parsed) return "unstated"

	// The winner IS a region resolution — the qualifier is the thing that resolved, so containment
	// degenerates to identity. The resolver's own binding (alias-aware, unlike the fold) is the
	// match evidence here; re-checking it under fold-equality would misread every alias hit as a
	// contradiction.
	if (winner.tag === "region") return "confirmed"

	const regionAncestors = (winner.ancestry ?? []).filter((a) => REGION_CLASS_PLACETYPES.has(a.placetype))

	if (!regionAncestors.length) return "unverifiable"

	const parsedKeys = regionKeys(parsed)

	for (const ancestor of regionAncestors) {
		if (intersects(parsedKeys, regionKeys(ancestor.name))) return "confirmed"
	}

	return "contradicted"
}

function countryVerdict(parsedCountry: string | undefined, winner: AdminCoherenceWinner): AdminCoherenceVerdict {
	const parsed = parsedCountry?.trim()

	if (!parsed) return "unstated"

	if (winner.tag === "country") return "confirmed"

	// Country-class evidence on the winner: the resolver-stamped alpha-2, expanded through the codex
	// tables into every spelling the check can vouch for, plus any country-placetype ancestors.
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

	if (!winnerKeys.size) return "unverifiable"

	return intersects(countryKeys(parsed), winnerKeys) ? "confirmed" : "contradicted"
}

/**
 * Assess the parsed admin qualifiers against the winning candidate. Pure — no I/O, no lookup, no side effects; call it
 * once at result assembly, only when a winner exists (no winner → no report, absence meaning "nothing resolved to check
 * against").
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
 * A resolved-tree node slice the assembly adapter reads — structurally satisfied by `@mailwoman/core`'s `AddressNode`,
 * declared locally so the pure module carries no decoder import.
 */
export interface AdminCoherenceSourceNode {
	tag: string
	value: string
	metadata?: Record<string, unknown> | undefined
}

/**
 * The assembly-point adapter: derive the parsed qualifiers (the `region` / `country` node spans — the parse view) and
 * the winner's checkable ancestry (the `resolver_country` stamp + any `metadata.ancestors` chain) off the resolved
 * tree's nodes, and return a spreadable result fragment. `winner` is the admin-ladder pick; `fallbackWinner` is the
 * primary resolved node the street-backed tiers report instead (the resolution context the coordinate was scoped by).
 * No winner at all → an empty fragment: the `admin_coherence` field stays ABSENT, which is a different claim from
 * `unverifiable` (nothing resolved, so there was no candidate to check).
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
			// Stamped only on the #404 opt-in path (WOF backend); the candidate backend has no ancestors
			// table, so this is usually absent — which the verdicts report as `unverifiable`.
			ancestry: picked.metadata?.["ancestors"] as readonly AdminAncestor[] | undefined,
		}
	)

	return { admin_coherence: report }
}
