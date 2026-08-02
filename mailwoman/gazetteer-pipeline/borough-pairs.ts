/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Hierarchy campaign R2 — borough (child, parent) pairs from the shipped WOF admin DB, emitted
 *   in the pair-index entry shape. Boroughs PROJECT onto `dependent_locality` (the schema umbrella
 *   term — see plan/reference/placetype-evidence.mdx), so the entries ride the existing PIX1 tag;
 *   no format change.
 *
 *   Scope discipline: the extractor is country-filtered — only locales with a CARRIER package and
 *   a contextually-alive tag receive entries (GB/London first; a perfect index against a dead tag
 *   is zero, the v385 control's lesson). The 211-borough census (2026-08-01): London 33, Tokyo 23,
 *   Paris 20, Rotterdam 23, Amsterdam 8 (compass-named — the directional-homograph class; they
 *   enter ONLY when their locale carrier exists, and law-1-style directional care applies).
 *   Berlin-style duplicates (locality + localadmin parents) dedupe on (child, parent) surface.
 *
 *   CURRENCY (added 2026-08-02, after the fact): both ends of the pair must be LIVE — `is_current != 0 AND
 *   is_deprecated = 0`, the same predicate `granularity.ts` uses. Without it the extraction asserted pairs WOF itself
 *   marks superseded or deprecated: measured 1,175 such pairs in the shipped US index (2.4%), 18 in GB, 2 in DE. The
 *   ingest already hard-rejects `wof:superseded_by` records, but `edtf:deprecated` and `mz:is_current` are RECORDED as
 *   columns rather than rejected, so filtering them is the reader's job and this reader was not doing it.
 */

import { DatabaseSync } from "node:sqlite"

import { isOfficialLanguage } from "@mailwoman/codex/country"

/**
 * One borough pair in the pair-index entry shape (`normalizeFSTToken`-folded keys are the BUILDER's job — this module
 * emits raw surfaces so the caller applies the same fold as the PPD path, keeping one normalization owner).
 */
export interface BoroughPair {
	child: string
	parent: string
	tag: "dependent_locality"
}

/**
 * Which WOF placetypes count as the child and the parent of an extracted pair, per country.
 *
 * This is deliberately per-country rather than one global rule, because the two shipped instances are shaped by their
 * SOURCES, not by a universal truth about hierarchy:
 *
 * - **GB** takes boroughs only. Its neighbourhood pairs come from a curated, venue-confound-boarded file
 *   (`data/gazetteer/london-pairs-v2.jsonl`, campaign R4b) — sweeping in all ~20k GB WOF neighbourhoods here would ship
 *   an unboarded batch and skip the law-1 discipline every GB increment has cleared.
 * - **US** takes boroughs AND neighbourhoods, and admits `borough` as a PARENT. WOF parents US neighbourhoods to the
 *   LOCALITY, not to the borough ("Astoria" hangs off New York, not off Queens), so a locality-only parent rule
 *   silently drops the borough-level pairs the US instance exists for (campaign R5).
 *
 * A country absent from this table gets the GB-shaped default, so adding a country is an explicit act.
 */
const PAIR_PLACETYPES_BY_COUNTRY: Readonly<
	Record<string, { children: readonly string[]; parents: readonly string[]; expandParentAliases?: boolean }>
> = {
	US: { children: ["borough", "neighbourhood"], parents: ["locality", "localadmin", "borough"] },
	DE: { children: ["borough", "neighbourhood"], parents: ["locality", "localadmin", "borough"] },
	// India is the ONE country where parent aliases are enabled, and it is enabled because it was measured there.
	// Indian cities carry official renames that WOF has not promoted: it stores Bangalore while an address today says
	// Bengaluru (renamed 2014, present as an `eng` VARIANT). Without expansion the pair exists and never fires —
	// "12 MG Road, Indiranagar, Bengaluru" emitted no dependent locality at all.
	//
	// NOT enabled globally, deliberately. Applying it everywhere took the US index from 47,878 to 101,560 — more than
	// double, on surfaces no board has ever graded. Every other increment in this campaign cleared a venue-confound
	// board before shipping, and a 2× expansion of the flagship locale is exactly the kind of change that earns one
	// rather than riding in on another country's evidence.
	IN: {
		children: ["borough", "neighbourhood"],
		parents: ["locality", "localadmin", "borough"],
		expandParentAliases: true,
	},
	// ES and IT need aliases for the reason India did, in their OWN languages rather than English: WOF stores `Rome`
	// for a city written `Roma`, and `Cordoba` for one written `Córdoba`. The fold does NOT strip accents, so
	// `cordoba` and `córdoba` are different keys and the unaccented WOF form would never match a real address.
	ES: {
		children: ["borough", "neighbourhood"],
		parents: ["locality", "localadmin", "borough"],
		expandParentAliases: true,
	},
	IT: {
		children: ["borough", "neighbourhood"],
		parents: ["locality", "localadmin", "borough"],
		expandParentAliases: true,
	},
}

const DEFAULT_PAIR_PLACETYPES: {
	children: readonly string[]
	parents: readonly string[]
	expandParentAliases?: boolean
} = {
	children: ["borough"],
	parents: ["locality", "localadmin"],
}

/**
 * Shortest parent alias worth indexing. WOF's `eng` variants include airport and agency codes ("BLR", "BBMP" for
 * Bangalore) — three letters or fewer is overwhelmingly that class rather than a name anyone writes in an address, and
 * a short key is the shape most likely to collide with an unrelated word.
 */
const MIN_ALIAS_LENGTH = 3

/**
 * A surface this Latin-script model could actually read: letters (including accented and extended Latin), digits,
 * spaces and the punctuation place names carry. Anything with a character outside that range is a non-Latin rendering
 * of the same place and costs artifact bytes for a form no input will ever contain.
 */
const LATIN_SURFACE_PATTERN = /^[\p{Script=Latin}\p{Mark}0-9 '\-.,()/]+$/u

/**
 * Extract dependent-locality-class (child, parent) pairs for one country from a WOF admin DB. Read-only; dedupes
 * (child, parent) across the locality/localadmin parent duplication. See {@link PAIR_PLACETYPES_BY_COUNTRY} for why the
 * placetype sets are per-country.
 */
export function extractBoroughPairs(adminDBPath: string, country: string): BoroughPair[] {
	const db = new DatabaseSync(adminDBPath, { readOnly: true })

	try {
		const { children, parents, expandParentAliases } = PAIR_PLACETYPES_BY_COUNTRY[country] ?? DEFAULT_PAIR_PLACETYPES
		// Placetype names are module constants, never caller input — inlining them keeps one prepared statement rather
		// than a variable-arity parameter list.
		const childList = children.map((placetype) => `'${placetype}'`).join(", ")
		const parentList = parents.map((placetype) => `'${placetype}'`).join(", ")

		const rows = db
			.prepare(
				`SELECT DISTINCT s.name AS child, p.name AS parent
				 FROM spr s
				 JOIN ancestors a ON a.id = s.id
				 JOIN spr p ON p.id = a.ancestor_id
				 WHERE s.placetype IN (${childList})
				   AND p.placetype IN (${parentList})
				   AND s.country = ?
				   AND p.country = s.country
				   AND s.is_current != 0
				   AND s.is_deprecated = 0
				   AND p.is_current != 0
				   AND p.is_deprecated = 0`
			)
			.all(country) as Array<{ child: string; parent: string }>

		// Parent ALIAS expansion. A writer uses the name they know, which is not always WOF's preferred one: WOF stores
		// Bangalore, while an Indian address today almost always says Bengaluru (renamed 2014, and WOF carries it as an
		// `eng` VARIANT rather than the preferred name). Without this the pair exists and never fires.
		//
		// Scoped to `eng` deliberately. The names table is exhaustively multilingual — Bangalore alone carries ~100
		// language rows — and folding all of them in would bloat the artifact with scripts this Latin model never sees
		// and surfaces no English-written address uses. The existing surface-expansion probe
		// (`pair-index-hierarchy-probe.ts`) gates on `official = 1`; that is right for name-exactness checks but too
		// strict here, because it is exactly the rows a rename leaves behind. Positive evidence only: an extra parent
		// key can only create a match where the writer actually used that name.
		const aliasRows = !expandParentAliases
			? []
			: (db
					.prepare(
						`SELECT s.name AS canonical, n.name AS alias, n.language AS language
				 FROM names n
				 JOIN spr s ON s.id = n.id
				 WHERE s.country = ?
				   AND s.placetype IN (${parentList})
				   AND s.is_current != 0 AND s.is_deprecated = 0
				   AND LENGTH(n.name) > ${MIN_ALIAS_LENGTH}`
					)
					.all(country) as Array<{ canonical: string; alias: string; language: string }>)

		const aliasesByParent = new Map<string, Set<string>>()

		for (const { canonical, alias, language } of aliasRows) {
			if (!canonical || !alias || canonical === alias) continue

			// The WRITER's language decides which alias is worth carrying: the country's own official languages, plus
			// English as the lingua franca. WOF's preferred name is often neither — it stores `Rome` (eng) for a city
			// Italians write `Roma` (ita), and `Bangalore` for one Indians write `Bengaluru`. Gating on `eng` alone, as
			// this did when India motivated it, misses every Italian and Spanish form.
			//
			// `isOfficialLanguage` is the codex table the WOF ingest already consults for exactly this question, so
			// "which languages does this country write in" keeps one owner instead of gaining a second hardcoded list.
			if (language !== "eng" && !isOfficialLanguage(country, language)) continue

			// LATIN SCRIPT ONLY. India has 22 official languages and WOF carries Devanagari, Tamil and Bengali names
			// for its cities; this model never sees those scripts, so indexing them is pure artifact weight. The check
			// is on the alias, not the language tag, because a language can be written in more than one script.
			if (!LATIN_SURFACE_PATTERN.test(alias)) continue

			const set = aliasesByParent.get(canonical) ?? new Set<string>()

			set.add(alias)
			aliasesByParent.set(canonical, set)
		}

		const seen = new Set<string>()
		const pairs: BoroughPair[] = []

		for (const { child, parent } of rows) {
			const key = `${child} ${parent}`

			if (seen.has(key) || !child || !parent || child === parent) continue

			seen.add(key)
			pairs.push({ child, parent, tag: "dependent_locality" })

			for (const alias of aliasesByParent.get(parent) ?? []) {
				const aliasKey = `${child} ${alias}`

				if (seen.has(aliasKey) || child === alias) continue

				seen.add(aliasKey)
				pairs.push({ child, parent: alias, tag: "dependent_locality" })
			}
		}

		return pairs
	} finally {
		db.close()
	}
}
