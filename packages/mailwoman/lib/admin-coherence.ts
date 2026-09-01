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
 *   carries no ancestry to check at all (the `unverifiable` count).
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
 *     the SQLite lookup implementation into this pure module — deliberately skipped.
 *   - The only normalizers consulted beyond the fold are the codex tables, because they are pure
 *     and already in-house: {@link matchCountry} (surface form / alpha-2 / alpha-3 → country) and
 *     {@link matchSubdivision} (US state + CA province code ↔ name). So `IL` confirms against
 *     `Illinois` and `Deutschland` against a DE winner, but an uncurated endonym (`Alemania`)
 *     against a DE winner reads `contradicted` — the module never silently over-claims a match it
 *     cannot derive.
 *   - The region verdict additionally carries the MISLABEL BRIDGE: a region slot holding a COUNTRY
 *     name ("Batumi, Georgia" parses region="Georgia") confirms against the winner's country-class
 *     evidence, because containment holds and `contradicted` would misdescribe the geography. It
 *     runs after the region band, is monotone (`contradicted`/`unverifiable` → `confirmed` is the
 *     only movement it can cause), and inherits the pure-codex bound above — parsed "Russia"
 *     against an RU winner still reads `contradicted`, because codex holds only "Russian
 *     Federation" for RU and the module never over-claims.
 *
 *   The winner's checkable ancestry arrives as the resolver's `metadata.ancestors` stamp (#404 —
 *   the geocode path opts in by default, and both backends serve it when their artifact carries an
 *   ancestors table: the FTS shard's `ancestors`, candidate.db's `candidate_ancestor` sidecar),
 *   while country-class ancestry is nearly always available via the `resolver_country` stamp.
 *   `unverifiable` remains the faithful verdict wherever the stamp is absent — an artifact
 *   predating the sidecar, a shard-fed winner with no recorded ancestry, or a caller that opted
 *   out.
 */

import { countrySurfaceForms, ISO2_TO_NAME, matchCountry } from "@mailwoman/codex/country"
import { REGION_CLASS_PLACETYPES, regionKeys } from "@mailwoman/resolver-wof-sqlite/region-keys"
import { normalizeLocalityForKey } from "@mailwoman/resolver-wof-sqlite/street-normalize"

/**
 * One admin-coherence verdict. See the module docstring for the exact meaning of each — in particular, `unverifiable`
 * is an absence-of-evidence claim about the WINNER, never about the parse.
 */
type AdminCoherenceVerdict = "confirmed" | "contradicted" | "unstated" | "unverifiable"

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
interface AdminAncestor {
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
 * Fold both sides of every name comparison through the shared candidate.db `name_key` normalizer — one function, both
 * sides, so the check can never disagree with the index it's checking against.
 *
 * The region-side expansion ({@link regionKeys}) and the region band ({@link REGION_CLASS_PLACETYPES}) moved DOWN to
 * `@mailwoman/resolver-wof-sqlite/region-keys` when the #1717 stage-2 containment re-rank became their second consumer
 * — the dependency points that way, and the #861 rule wants one function, not a mirrored copy.
 */
function foldKey(name: string): string {
	return normalizeLocalityForKey(name)
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

/**
 * The winner's COUNTRY-class evidence keys: the resolver-stamped alpha-2 expanded through the codex tables into every
 * spelling the check can vouch for, plus any country-placetype ancestors. One assembly, two consumers — the country
 * verdict compares against it, and the region verdict's mislabel bridge (below) does too, so the two verdicts can never
 * disagree about what counts as country-class evidence.
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

	// The winner IS a region resolution — the qualifier is the thing that resolved, so containment
	// degenerates to identity. The resolver's own binding (alias-aware, unlike the fold) is the
	// match evidence here; re-checking it under fold-equality would misread every alias hit as a
	// contradiction.
	if (winner.tag === "region") return "confirmed"

	const regionAncestors = (winner.ancestry ?? []).filter((a) => REGION_CLASS_PLACETYPES.has(a.placetype))
	const iso = winner.countryCode?.trim().toUpperCase() || undefined
	const parsedKeys = regionKeys(parsed, iso)

	for (const ancestor of regionAncestors) {
		if (intersects(parsedKeys, regionKeys(ancestor.name, iso))) return "confirmed"
	}

	// The mislabel bridge: the region SLOT sometimes holds a COUNTRY name — "Moscow, Russia" parses
	// region="Russia", "Batumi, Georgia" parses region="Georgia" (the shape the flag's own first
	// triage counted at ~4 of 16 contradictions). Containment still holds when the winner's
	// country-class evidence matches the qualifier, so `contradicted` would be the wrong claim about
	// the geography. Checked AFTER the region band (a genuine region match never depends on it) and
	// monotone by construction: it can only move `contradicted`/`unverifiable` → `confirmed`.
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
			// The resolver's #404 stamp — present when the geocode path opted in AND the backend's
			// artifact carries an ancestors table; its absence is what the verdicts report as
			// `unverifiable`.
			ancestry: picked.metadata?.["ancestors"] as readonly AdminAncestor[] | undefined,
		}
	)

	return { admin_coherence: report }
}

/**
 * A node tree shaped like the decoder's `AddressNode` — structural rather than imported, so this module stays free of
 * the decoder dependency.
 */
export interface AdminCoherenceTreeNode extends AdminCoherenceSourceNode {
	children: readonly AdminCoherenceTreeNode[]
}

/**
 * Coherence for a fork-to-entity answer (#1724): a forked answer carries a verdict like any other resolved answer --
 * absence means "nothing resolved to check", and something did. The entity offers a country and no ancestor chain, so a
 * stated region grades `unverifiable` rather than going silently unchecked.
 */
export function forkedEntityCoherenceField(
	roots: readonly AdminCoherenceTreeNode[],
	entity: { name: string; country: string }
): { admin_coherence?: AdminCoherenceReport } {
	const nodes: AdminCoherenceSourceNode[] = []
	const stack: AdminCoherenceTreeNode[] = [...roots]

	while (stack.length) {
		const n = stack.pop()!

		nodes.push({ tag: n.tag, value: n.value, metadata: n.metadata })
		stack.push(...n.children)
	}

	return adminCoherenceField(
		nodes,
		{ tag: "venue", value: entity.name, metadata: { resolver_country: entity.country } },
		undefined
	)
}
