/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Extract `(postcode, locality, region, country)` tuples for the `trailing-region` shard.
 *
 *   This step used to be a one-off. Its output survived — 17,908 rows at
 *   `$MAILWOMAN_DATA_ROOT/corpus/tuples/trailing-region-structured-tuples.jsonl` — but the code that produced it did
 *   not, so a note describing the join was the only record and it did not match what the databases contain. That is the
 *   reason this file exists: the shard is unbuildable for a new country without it.
 *
 *   ## Two sources, because one route does not reach every country
 *
 *   - **`postalcode-intl.db`** carries a real `parent_id` that resolves in the admin gazetteer. Measured share of rows
 *     with a parent: NL 97.5%, FR 90.7%, DE 66.1%, ES 34.9%, IT 27.4%; of those, 93.8–100% land on a `locality` or
 *     `localadmin`, and the region comes from that place's own ancestry. It is the ONLY shard with this — every
 *     `postalcode-geonames-*` and `postalcode-<cc>-overture.db` row reads `parent_id = 0`.
 *   - **GeoNames postal exports** carry the place and admin1 NAMES in columns 3 and 4, so there is nothing to join.
 *     `mailwoman corpus fetch geonames-postal` puts them on disk.
 *
 *   A nearest-locality-centroid join was measured as the general fallback and REJECTED: scored against the `parent_id`
 *   truth, it agreed NL 81.1% / DE 44.7% / ES 35.1% / FR 29.0% / IT 13.5%. A locality's centroid sits at its middle, so
 *   an edge postcode is routinely nearer a neighbouring town's centroid. Do not reach for it again.
 *
 *   ## The hub cap is PER COUNTRY, because a pooled one is a mixture
 *
 *   A few localities act as catch-all parents — `Schwedt/Oder` claims 9,222 DE postcodes against a DE median of 1. Left
 *   in, a handful of places dominate the shard. But the distribution differs so much by country that one threshold is
 *   not one rule: a p99 pooled across the five countries lands at 522, which keeps 100% of ES and IT, 83% of FR, 49% of
 *   NL and 19% of DE.
 *
 *   So the bound is a QUOTA and not a threshold. A threshold DELETES a locality that exceeds it, which removes exactly
 *   the largest cities — the places a parser most needs to have seen. A quota keeps every locality and bounds how many
 *   of its postcodes ride along, which is the balance the cap was reaching for without the deletion.
 *
 *   ## Placement is data, not a formatting choice
 *
 *   Each tuple is stamped with its country's {@link PostcodePlacement}. The same digits change tag with position, so a
 *   tuple that does not carry its placement teaches whichever convention the recipe happens to default to — see the
 *   recipe's header for the measurement.
 */

import { existsSync } from "node:fs"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { dataRootPath } from "@mailwoman/core/utils"
import { TSVSpliterator } from "spliterator"

import type { PostcodePlacement } from "../shard-recipes/scaffold.ts"

/**
 * One extracted tuple, in the shape `readTuples` yields and the recipe consumes.
 */
export interface PostcodeTriple {
	postcode: string
	/**
	 * The segment before the locality, when the source has one. A shard whose every row begins with the locality teaches
	 * that the first named segment IS the locality, and that flips the model's default. Measured on the v4.8.0 candidate,
	 * which had no such segment — `Ye Three Lords, 27 Minories, London EC3N 1DE` came back `locality: "Ye Three Lords"`
	 * with the venue and the street both gone, and 11 of its 25 regressions were venue-led rows across seven countries.
	 */
	dependentLocality?: string
	locality: string
	region: string
	country: string
	cc: string
	locale: string
	postcodePlacement: PostcodePlacement
}

/**
 * Where a country writes the postcode, and the locale tag its rows carry.
 *
 * A country is in this table only when a gauntlet board row ATTESTS its surface. An absent country is not an oversight
 * to be filled in by guessing: extracting it with the wrong placement teaches a convention that country does not use,
 * which is worse than not teaching it at all. `LEADING_POSTCODE_COUNTRIES` in `@mailwoman/neural`'s
 * `placetype-pair-prior.ts` draws the same line for the same reason.
 *
 * AU and ZA are the worked examples of the bar. Both look like obvious additions and neither qualifies: the board's AU
 * rows are bare-city (`Melbourne`, `Sydney, Australia`) and carry no postcode at all, so nothing here says where AU
 * writes it; and ZA's `14 Long St, Green Point, Cape Town, 8001` carries no REGION, which this shard requires — a fact
 * its GeoNames export agrees with, at 100% place and 0% admin1.
 */
export const POSTCODE_CONVENTIONS: ReadonlyMap<string, { placement: PostcodePlacement; locale: string }> = new Map([
	// `Rue de l'Église, 3, 29217 Plougonvelin, Bretagne, France` and its siblings — `fr_structured`, `de_structured`,
	// `es_structured`, `it_structured`, `pt_structured`, `mx_supermanzana`, `nl-op4-p-r-sloterdijk`.
	["FR", { placement: "leading", locale: "fr-FR" }],
	["DE", { placement: "leading", locale: "de-DE" }],
	["ES", { placement: "leading", locale: "es-ES" }],
	["IT", { placement: "leading", locale: "it-IT" }],
	["NL", { placement: "leading", locale: "nl-NL" }],
	["PT", { placement: "leading", locale: "pt-PT" }],
	["MX", { placement: "leading", locale: "es-MX" }],
	// `…, Barcelona 6001, Anzoátegui, Venezuela` — the four `ve_city_postcode_trailing_state` rows. No postcode source
	// on disk and GeoNames does not publish VE, so this entry currently yields nothing; it is here because the
	// placement is what makes the absence legible.
	["VE", { placement: "after_locality", locale: "es-VE" }],
	// `12 MG Road, Indiranagar, Bengaluru, Karnataka 560038, India` — three `in_*` rows, and `AGENTS.md` says the same
	// ("en-IN is absent BECAUSE the PIN goes last"). The one trailing placement with real data behind it.
	["IN", { placement: "after_region", locale: "en-IN" }],
])

/**
 * How many postcodes one locality may contribute.
 *
 * A quota rather than a cut-off — see the header. It bounds repetition without deleting a locality: a city with 9,222
 * postcodes contributes this many and stays in the shard.
 */
export const DEFAULT_LOCALITY_QUOTA = 24

/**
 * Take at most `quota` tuples per locality, in the order they arrive.
 *
 * Order matters and is the caller's to choose: both readers below walk their source in id / file order, which is stable
 * across runs, so the same quota selects the same rows.
 */
export function applyLocalityQuota(
	triples: readonly PostcodeTriple[],
	quota: number = DEFAULT_LOCALITY_QUOTA
): PostcodeTriple[] {
	const seen = new Map<string, number>()
	const kept: PostcodeTriple[] = []

	for (const triple of triples) {
		const key = `${triple.cc} ${triple.locality}`
		const n = seen.get(key) ?? 0

		if (n >= quota) continue

		seen.set(key, n + 1)
		kept.push(triple)
	}

	return kept
}

/**
 * Take at most `budget` tuples per COUNTRY, in the order they arrive.
 *
 * A per-locality quota bounds how often one place repeats; it cannot bound a country. IN has 128,152 distinct
 * localities, so even at a quota of ONE it contributes 63,533 rows against 39,790 from the other seven combined — the
 * shard would teach the trailing surface as an Indian fact rather than a general one, and at 103,323 rows it would take
 * 30% of an 8,000-step run's sample budget at three reps per row.
 *
 * Applied AFTER {@link applyLocalityQuota}, so a country's budget is spent on breadth (many localities) rather than on
 * one city's postcode list.
 */
export function applyCountryBudget(
	triples: readonly PostcodeTriple[],
	budget: number | ReadonlyMap<string, number>
): PostcodeTriple[] {
	const spent = new Map<string, number>()
	const kept: PostcodeTriple[] = []

	for (const triple of triples) {
		const cap = typeof budget === "number" ? budget : budget.get(triple.cc)

		if (cap === undefined) continue

		const n = spent.get(triple.cc) ?? 0

		if (n >= cap) continue

		spent.set(triple.cc, n + 1)
		kept.push(triple)
	}

	return kept
}

/**
 * Read triples out of `postalcode-intl.db` by following each postcode's `parent_id` into the admin gazetteer and that
 * place's ancestry to a region.
 *
 * A postcode whose parent does not resolve, or whose parent has no region ancestor, is DROPPED rather than emitted with
 * a blank — the recipe already skips a tuple with no region, and a blank here would hide how much of the source is
 * actually reachable.
 */
export function readTriplesFromParentJoin(
	countries: readonly string[],
	options: { postcodeDB?: string; adminDB?: string } = {}
): PostcodeTriple[] {
	const postcodeDB = options.postcodeDB ?? String(dataRootPath("wof", "postalcode-intl.db"))
	const adminDB = options.adminDB ?? String(dataRootPath("wof", "admin-global-priority-importance.db"))

	if (!existsSync(postcodeDB) || !existsSync(adminDB)) return []

	const db = new DatabaseSync(adminDB, { readOnly: true })

	try {
		db.exec(`ATTACH DATABASE '${postcodeDB.replaceAll("'", "''")}' AS pc`)

		const statement = db.prepare(`
			SELECT p.name AS postcode, a.name AS locality, r.name AS region, c.name AS country, p.country AS cc
			FROM pc.spr p
			JOIN spr a ON a.id = p.parent_id AND a.placetype IN ('locality', 'localadmin')
			JOIN ancestors anc ON anc.id = a.id AND anc.ancestor_placetype = 'region'
			JOIN spr r ON r.id = anc.ancestor_id
			JOIN ancestors cnc ON cnc.id = a.id AND cnc.ancestor_placetype = 'country'
			JOIN spr c ON c.id = cnc.ancestor_id
			WHERE p.country = ? AND p.parent_id > 0
			ORDER BY p.id
		`)

		const out: PostcodeTriple[] = []

		for (const cc of countries) {
			const convention = POSTCODE_CONVENTIONS.get(cc)

			if (!convention) continue

			for (const row of statement.all(cc) as Array<Record<string, string>>) {
				if (!row["postcode"] || !row["locality"] || !row["region"]) continue

				out.push({
					postcode: row["postcode"],
					locality: row["locality"],
					region: row["region"],
					country: row["country"] ?? "",
					cc,
					locale: convention.locale,
					postcodePlacement: convention.placement,
				})
			}
		}

		return out
	} finally {
		db.close()
	}
}

/**
 * GeoNames postal columns (0-based), matching `@mailwoman/corpus`'s `geonames-postal` adapter.
 */
const GEONAMES_COL = { country: 0, postcode: 1, place: 2, admin1: 3, admin2: 5 } as const

/**
 * A predicate answering whether a name is a LOCALITY the admin gazetteer knows, for one country.
 *
 * The parent-join reader gets this for free — its query restricts the parent to `locality`/`localadmin`, so every name
 * it emits is one by construction. The GeoNames reader has no such guarantee, and the gap is large enough to matter:
 * sampling 400 rows per country against the gazetteer, the share of GeoNames place names that name a locality we know
 * is PT 75%, IN 62%, **MX 41%**. The Mexican misses are colonias — `Zona Centro`, `San Fernando INFONAVIT`, `FOVISSSTE
 * 3a Sección` — and a row teaching one of those as `locality` trains the locality/dependent_locality boundary in the
 * wrong direction. Dropping the row instead costs coverage and teaches nothing false, which is the better of the two.
 *
 * Returns a predicate that answers `true` for everything when the gazetteer is not on disk, so a checkout without it
 * builds the same rows it did before rather than silently emitting none.
 */
export function createKnownLocalityGate(country: string, adminDB?: string): (name: string) => boolean {
	const path = adminDB ?? String(dataRootPath("wof", "admin-global-priority-importance.db"))

	if (!existsSync(path)) return () => true

	const db = new DatabaseSync(path, { readOnly: true })

	try {
		const names = new Set<string>()

		for (const row of db
			.prepare("SELECT name FROM spr WHERE country = ? AND placetype IN ('locality', 'localadmin')")
			.all(country) as Array<{ name: string | null }>) {
			if (row.name) {
				names.add(row.name.toLowerCase())
			}
		}

		// An empty set means the gazetteer has no localities for this country at all, which is a coverage fact about the
		// gazetteer rather than a verdict on the source — so gate nothing rather than drop everything.
		if (!names.size) return () => true

		return (name: string) => names.has(name.toLowerCase())
	} finally {
		db.close()
	}
}

/**
 * Read triples straight out of a GeoNames `<CC>.txt` export — no join, the names are columns 3 and 4.
 *
 * COLUMN 3 IS NOT THE LOCALITY. It is the finest-grained named place for the code, and for `560001` that is `Mahatma
 * Gandhi Road` — a STREET — while the city, `Bengaluru`, is column 5 (admin2). MX is the same shape (`Roma Norte` is a
 * colonia inside `Cuauhtémoc`) and so is PT (`Abrigada` inside `Alenquer`). Reading column 3 as the locality is how the
 * v4.8.0 shard came to teach street names as cities. So `admin2` is the locality, `admin1` the region, and column 3 the
 * DEPENDENT locality — which is also the left context the shard needs.
 *
 * WHICH COUNTRIES THIS READER CAN SERVE. It needs `admin2` (the city) and `admin1` (the region), and a country can
 * publish one without the other. Measured 2026-08-23 across the exports on disk:
 *
 * | country    | rows      | admin1 | admin2 | usable here                     |
 * | ---------- | --------: | -----: | -----: | ------------------------------- |
 * | PT, MX, IN | 145k–207k | 100%   | 100%   | yes                             |
 * | BD, LK     | 1.3k–1.8k | 100%   | 100%   | yes                             |
 * | PH         | 2,317     | 88%    | 88%    | yes, 88% of rows                |
 * | PK         | 2,563     | 100%   | **0%** | NO — no city column             |
 * | TH         | 903       | 100%   | **1%** | NO — effectively no city column |
 * | ID         | 81,058    | **0%** | 0%     | NO — no region either           |
 * | ZA         | 3,920     | **0%** | —      | NO                              |
 *
 * A country in the NO rows yields zero from this reader, and that is the correct outcome rather than a gap to route
 * around: taking column 3 as the locality is what made the v4.8.0 shard train `Mahatma Gandhi Road` as a city. If one
 * of them is wanted, it needs a city column from somewhere else, not a relaxed mapping.
 *
 * NOT PUBLISHED AT ALL by GeoNames, checked the same day: VE, VN, NP, MM, KH. Those are acquisition questions, and for
 * VE specifically OpenAddresses 404s too — see the arc retrospective.
 *
 * Three source properties a caller cannot see from a row count, all handled here. Hyphen-format countries publish each
 * code TWICE (`3750-000` and `3750000`, exactly 2.00× for PT and PL), so the first surface of a code wins and its twin
 * is dropped. Some countries populate the place but not admin1 — ZA is 100% place, 0% region — which yields nothing
 * this shard can use, so those rows are dropped rather than emitted with a blank region. And the "place name" is often
 * a SUB-locality, which {@link createKnownLocalityGate} filters.
 */
export async function readTriplesFromGeonames(
	country: string,
	path: string,
	countryName: string,
	options: { isKnownLocality?: (name: string) => boolean } = {}
): Promise<PostcodeTriple[]> {
	const convention = POSTCODE_CONVENTIONS.get(country)

	if (!convention || !existsSync(path)) return []

	const isKnownLocality = options.isKnownLocality ?? createKnownLocalityGate(country)
	const out: PostcodeTriple[] = []
	const seen = new Set<string>()

	for await (const cells of TSVSpliterator.fromAsync(path, { header: false }) as AsyncIterable<string[]>) {
		const postcode = (cells[GEONAMES_COL.postcode] ?? "").trim()
		const dependentLocality = (cells[GEONAMES_COL.place] ?? "").trim()
		const locality = (cells[GEONAMES_COL.admin2] ?? "").trim()
		const region = (cells[GEONAMES_COL.admin1] ?? "").trim()

		if (!postcode || !locality || !region) continue

		// The gate applies to the LOCALITY — admin2 — not to the fine-grained name, which is expected to be a street or
		// a colonia and is emitted as the dependent locality rather than dropped.
		if (!isKnownLocality(locality)) continue

		// A dependent locality that merely repeats its parent teaches a doubled segment, not a boundary.
		const dep = dependentLocality && dependentLocality !== locality ? dependentLocality : ""

		// The bare twin of a punctuated code carries no new fact, and keeping both doubles the country's weight.
		const key = `${postcode.replaceAll("-", "")} ${locality} ${dep}`

		if (seen.has(key)) continue

		seen.add(key)

		out.push({
			postcode,
			...(dep ? { dependentLocality: dep } : {}),
			locality,
			region,
			country: countryName,
			cc: country,
			locale: convention.locale,
			postcodePlacement: convention.placement,
		})
	}

	return out
}

/**
 * Resolve a GeoNames export path under the standard fetch out-root.
 */
export function geonamesPostalPath(country: string, sourcesRoot?: string): string {
	const root = sourcesRoot ?? String(dataRootPath("corpus", "sources"))

	return join(root, "geonames-postal", `${country.toUpperCase()}.txt`)
}
