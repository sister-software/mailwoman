/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Extract `(postcode, locality, region, country)` tuples for the `trailing-region` recipe.
 *
 *   This step used to be a one-off. Its output survived — 17,908 rows at
 *   `$MAILWOMAN_DATA_ROOT/corpus/tuples/trailing-region-structured-tuples.jsonl` — but the code that produced it did
 *   not, so a note describing the join was the only record and it did not match what the databases contain. That is the
 *   reason this file exists: the recipe output is unbuildable for a new country without it.
 *
 *   ## Two sources, because one route does not reach every country
 *
 *   - **`postalcode-intl.db`** carries a real `parent_id` that resolves in the admin gazetteer. Measured share of rows
 *     with a parent: NL 97.5%, FR 90.7%, DE 66.1%, ES 34.9%, IT 27.4%; of those, 93.8–100% land on a `locality` or
 *     `localadmin`, and the region comes from that place's own ancestry. It is the only postcode database with this —
 *     every
 *     `postalcode-geonames-*` and `postalcode-<cc>-overture.db` row reads `parent_id = 0`.
 *   - **GeoNames postal exports** carry the place and admin1 names in columns 3 and 4, so there is no join to make.
 *     `mailwoman corpus fetch geonames-postal` puts them on disk.
 *
 *   A nearest-locality-centroid join was measured as the general fallback and rejected: scored against the `parent_id`
 *   truth, it agreed NL 81.1% / DE 44.7% / ES 35.1% / FR 29.0% / IT 13.5%. A locality's centroid sits at its middle, so
 *   an edge postcode is routinely nearer a neighbouring town's centroid. Do not reach for it again.
 *
 *   ## The hub cap is PER country, because a pooled one is a mixture
 *
 *   A few localities act as catch-all parents — `Schwedt/Oder` claims 9,222 DE postcodes against a DE median of 1. Left
 *   in, a handful of places dominate the recipe output. But the distribution differs so much by country that one
 *   threshold is
 *   not one rule: a p99 pooled across the five countries lands at 522, which keeps 100% of ES and IT, 83% of FR, 49% of
 *   NL and 19% of DE.
 *
 *   So the bound is a quota and not a threshold. A threshold deletes a locality that exceeds it, which removes exactly
 *   the largest cities — the places a parser most needs to have seen. A quota keeps every locality and bounds how many
 *   of its postcodes ride along, which is the balance the cap was reaching for without the deletion.
 *
 *   ## Placement is data rather than a formatting choice
 *
 *   Each tuple is stamped with its country's {@link PostcodePlacement}. The same digits change tag with position, so a
 *   tuple that does not carry its placement teaches whichever convention the recipe happens to default to — see the
 *   recipe's header for the measurement.
 */

import { officialLanguagesAlpha3, regionLanguagesAlpha3 } from "@mailwoman/codex/country"
import { foldName } from "@mailwoman/codex/normalize"
import { dataRootPath } from "@mailwoman/core/data-root"
import { assertPathExists } from "@mailwoman/core/fs/readers"
import { wofDatabasePath } from "@mailwoman/resolver-wof-sqlite/paths"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { PathBuilder, type PathBuilderLike } from "path-ts"
import { TSVSpliterator } from "spliterator"

import { GEONAMES_POSTAL_COLUMNS } from "#adapters/geonames/postal/adapter"
import { escapeSQLString } from "#parquet/duckdb"
import type { PostcodePlacement } from "#recipes/scaffold"

/**
 * One extracted tuple, in the shape `readTuples` yields and the recipe consumes.
 */
export interface PostcodeTriple {
	postcode: string
	/**
	 * The segment before the locality, when the source has one.
	 *
	 * A recipe output whose every row begins with the locality teaches that the first
	 * named segment is the locality, and that flips the model's default.
	 * Measured on the v4.8.0 candidate, which had no such segment.
	 *
	 * `Ye Three Lords, 27 Minories, London EC3N 1DE` came back `locality: "Ye Three Lords"` with the venue
	 * and the street both gone, and 11 of its 25 regressions were venue-led rows across seven countries.
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
 * Which GeoNames postal column carries the locality for a country.
 *
 * `admin2` is the default and what every {@link POSTCODE_CONVENTIONS} entry omitting it means:
 * for PT, MX and IN, column 3 is a sub-locality — a colonia, a street — and admin2 is the city.
 * **For the US it is the inverse**, and taking the default would train counties as cities:
 *
 *     US  94901  San Rafael     California    CA  Marin      ← column 3 is the city, admin2 the county
 *     US  60639  Chicago        Illinois      IL  Cook
 *     US  57107  Sioux Falls    South Dakota  SD  Minnehaha
 *
 * This is the same defect {@link readTriplesFromGeonames}'s own header records from the
 * other direction, where column 3 taught `Mahatma Gandhi Road` as a city.
 * The column a country's city sits in is data about that country's export,
 * so it is declared per country rather than inferred.
 */
export type GeonamesLocalityColumn = "place" | "admin2"

/**
 * Where a country writes the postcode, and the locale tag its rows carry.
 *
 * A country is in this table only when a gauntlet board row attests its surface.
 * An absent country is not an oversight to be filled in by guessing: extracting it with the wrong
 * placement teaches a convention that country does not use, which is worse than not teaching it at all.
 *
 * `LEADING_POSTCODE_COUNTRIES` in `@mailwoman/neural`'s `placetype-pair-prior.ts`
 * draws the same line for the same reason.
 *
 * AU and ZA are the worked examples of the bar.
 * Both look like obvious additions and neither qualifies: the board's AU rows
 * are bare-city (`Melbourne`, `Sydney, Australia`) and carry no postcode at all,
 * so no source here says where AU writes it.
 *
 * And ZA's `14 Long St, Green Point, Cape Town, 8001` carries no region, which this recipe
 * requires — a fact its GeoNames export agrees with, at 100% place and 0% admin1.
 */
export const POSTCODE_CONVENTIONS: ReadonlyMap<
	string,
	{ placement: PostcodePlacement; locale: string; localityColumn?: GeonamesLocalityColumn }
> = new Map([
	// `Rue de l'Église, 3, 29217 Plougonvelin, Bretagne, France` and its siblings —
	// `fr_structured`, `de_structured`, `es_structured`, `it_structured`, `pt_structured`,
	// `mx_supermanzana`, `nl-op4-p-r-sloterdijk`.
	["FR", { placement: "leading", locale: "fr-FR" }],
	["DE", { placement: "leading", locale: "de-DE" }],
	["ES", { placement: "leading", locale: "es-ES" }],
	["IT", { placement: "leading", locale: "it-IT" }],
	["NL", { placement: "leading", locale: "nl-NL" }],
	["PT", { placement: "leading", locale: "pt-PT" }],
	["MX", { placement: "leading", locale: "es-MX" }],
	// `…, Barcelona 6001, Anzoátegui, Venezuela` — the four `ve_city_postcode_trailing_state` rows.
	// No postcode source on disk and GeoNames does not publish VE, so this entry currently yields no row.
	// It is here because the placement is what makes the absence legible.
	["VE", { placement: "after_locality", locale: "es-VE" }],
	// `12 MG Road, Indiranagar, Bengaluru, Karnataka 560038, India`.
	// Three `in_*` rows, and `agents.md` says the same ("en-IN is absent because the PIN goes last").
	// The one trailing placement with real data behind it.
	["IN", { placement: "after_region", locale: "en-IN" }],
	// `Washington, DC 20003` — the #2303 class, and the same placement as IN.
	// Attested by the four `us_city_state_postcode` board rows, which is the bar this table sets.
	// The US had no entry here at all, so no recipe emitted a US city in front of a state code and a ZIP
	// without a street ahead of it, and the model reads the bare city as a street 45.7% of the time.
	// `localityColumn` is what keeps it from training counties.
	["US", { placement: "after_region", locale: "en-US", localityColumn: "place" }],
	// `shcs Superquadra Sul 308 - Asa Sul, Brasília - Federal District, 70390-100, Brazil`
	// and `Estrada do Imigrante, s/n — 3ª Légua / Galópolis — Caxias do Sul, RS 95090-020, Brazil` —
	// two `br_*` rows, each carrying locality, region and CEP in that order, which is the bar.
	// The default `admin2` column is right here and the US override would be wrong:
	// BR's export writes the municipality in column 3 and admin2 alike, with the state in admin1.
	//
	//     BR  69945-000  Acrelândia  Acre  01  Acrelândia  1200013
	["BR", { placement: "after_region", locale: "pt-BR" }],
])

/**
 * How many postcodes one locality may contribute.
 *
 * A quota rather than a cutoff — see the header.
 * It bounds repetition without deleting a locality: a city with 9,222 postcodes
 * contributes this many and stays in the recipe output.
 */
export const DEFAULT_LOCALITY_QUOTA = 24

/**
 * Take at most `quota` tuples per locality, in the order they arrive.
 *
 * Order matters and is the caller's to choose: both readers below walk their source
 * in id / file order, which is stable across runs.
 * Therefore, the same quota selects the same rows.
 */
export function applyLocalityQuota<T extends { cc: string; locality: string }>(
	triples: readonly T[],
	quota: number = DEFAULT_LOCALITY_QUOTA
): T[] {
	const seen = new Map<string, number>()
	const kept: T[] = []

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
 * Take at most `budget` tuples per country, in the order they arrive.
 *
 * A per-locality quota bounds how often one place repeats.
 * It cannot bound a country.
 *
 * IN has 128,152 distinct localities, so even at a quota of one it contributes
 * 63,533 rows against 39,790 from the other seven combined.
 * The recipe would teach the trailing surface as an Indian fact rather than a general one,
 * and at 103,323 rows it would take 30% of an 8,000-step run's sample budget at three reps per row.
 *
 * Applied after {@link applyLocalityQuota}, so a country's budget is spent on breadth
 * (many localities) rather than on one city's postcode list.
 *
 * Spent BY region, in rounds.
 * Source order is postcode order, and a postcode sorts geographically, so spending
 * the budget in file order provides one corner of a country.
 *
 * Measured on the tuples this tool had already produced: the US took its 16,000 from 23 of 56
 * states (`AK` through the alphabet and stop), Mexico 7 regions, Portugal 5, India 24 of 36.
 * A round-robin over the region takes one row from each before any region takes a second,
 * so a cap smaller than the source still reaches every region the source has.
 *
 * Within a region the source order is kept, so the same budget selects the same rows.
 *
 * `subKey` adds a second dimension to the round-robin, so the budget spreads across
 * `(region, subKey)` rather than across the region alone.
 * The US case it was added for: the source pool holds 76.8% single-word localities
 * and 10.5% whose last word is a USPS street suffix (`Orland Park`), and a region-only
 * round-robin reproduces that mix, so the recipe teaches the shape the model already
 * reads correctly and barely teaches the one it fails on.
 *
 * Keying the round-robin by shape as well lifts the suffix-tail share to what the
 * pool can supply rather than to what its frequency gives it.
 */
export function applyCountryBudget<T extends { cc: string; region?: string }>(
	triples: readonly T[],
	budget: number | ReadonlyMap<string, number>,
	subKey?: (triple: T) => string
): T[] {
	const byRegion = new Map<string, T[]>()
	const order: string[] = []

	for (const triple of triples) {
		const cap = typeof budget === "number" ? budget : budget.get(triple.cc)

		if (cap === undefined) continue

		const key = `${triple.cc} ${triple.region ?? ""}${subKey ? ` ${subKey(triple)}` : ""}`
		const bucket = byRegion.get(key)

		if (bucket) {
			bucket.push(triple)
		} else {
			byRegion.set(key, [triple])
			order.push(key)
		}
	}

	const spent = new Map<string, number>()
	const kept: T[] = []
	const deepest = Math.max(0, ...[...byRegion.values()].map((bucket) => bucket.length))

	for (let round = 0; round < deepest; round++) {
		for (const key of order) {
			const triple = byRegion.get(key)![round]

			if (!triple) continue

			const cap = typeof budget === "number" ? budget : budget.get(triple.cc)!
			const n = spent.get(triple.cc) ?? 0

			if (n >= cap) continue

			spent.set(triple.cc, n + 1)
			kept.push(triple)
		}
	}

	return kept
}

/**
 * A place's preferred names in the languages its addresses are written in,
 * read from the gazetteer's `names` table.
 */
interface PreferredNames {
	/**
	 * Preferred names in the country's official languages, in the table's order.
	 */
	official: readonly string[]
	/**
	 * Preferred names in the region's co-official languages.
	 */
	coOfficial: readonly string[]
}

/**
 * The surfaces a region is written as: its preferred names in the official language(s), then in
 * the region's co-official languages, then the gazetteer's own `spr.name` (the English exonym).
 *
 * Deduplicated, order kept.
 *
 * `spr.name` is the English-preferred, diacritic-stripped label, and reading it
 * alone is the defect #1673 measured: 53,078 ES rows teaching `Balearic Islands`
 * (2,872 `Andalusia`, 5,680 `Castile and Leon`) against 4 rows of `Illes Balears`,
 * and every province with its accent gone (`Cordoba`, `Leon`).
 * A Spanish user writes `Islas Baleares` or `Illes Balears`; the exonym stays as
 * one surface among them because a user may write it too.
 *
 * A {@link BILINGUAL_JOINED} `spr.name` yields both halves.
 * Nine regions carry one — `New Brunswick / Nouveau-Brunswick`, `Koper / Capodistria`,
 * `Naannoo Hararii / ሐረሪ ሕዝብ ክልል` — and the joined string is a label the gazetteer composes
 * rather than a name an address is written in, so taking it whole attests a surface
 * nobody writes and withholds the two that everybody does.
 */
export function regionWrittenForms(sprName: string, names: PreferredNames): string[] {
	const out: string[] = []

	for (const raw of [...names.official, ...names.coOfficial, ...sprName.split(BILINGUAL_JOINED)]) {
		const name = raw.trim().replace(PROVINCE_GENERIC, "")

		if (name && !out.includes(name)) {
			out.push(name)
		}
	}

	return out
}

/**
 * The separator Who's On First joins a region's two co-official names with.
 *
 * Spaces are required on both sides.
 * Nine of the gazetteer's current regions carry the form and every one of them is bilingual
 * (SI 7, CA 1, ET 1); a slash with no surrounding spaces appears inside single names and must not split.
 */
const BILINGUAL_JOINED = / \/ /

/**
 * The provincial generic Who's On First keeps in a province's Catalan and Asturian
 * preferred names (`Província de Barcelona`, `Província d'A Coruña`).
 *
 * An envelope carries the name alone, so the generic is dropped and the surface
 * dedupes against the Castilian one.
 */
const PROVINCE_GENERIC = /^prov[ií]ncia (?:de |d')/iu

/**
 * The surface a locality is written as: the official-language preferred name
 * that is `spr.name` with its diacritics restored (`Cordoba` → `Córdoba`),
 * else the first official-language preferred name, else `spr.name`.
 *
 * One surface rather than a fan-out: the region carries the multiplicity
 * and the locality would multiply it.
 */
export function localityWrittenForm(sprName: string, names: PreferredNames): string {
	const folded = foldName(sprName)

	return names.official.find((name) => foldName(name) === folded) ?? names.official[0] ?? sprName
}

/**
 * Read triples out of `postalcode-intl.db` by following each postcode's `parent_id`
 * into the admin gazetteer and that place's ancestry to a region.
 *
 * A postcode whose parent does not resolve, or whose parent has no region ancestor,
 * is dropped rather than emitted with a blank.
 * The recipe already skips a tuple with no region, and a blank here would hide
 * how much of the source is actually reachable.
 *
 * One triple per region surface (see {@link regionWrittenForms}): a Balearic postcode yields
 * `Islas Baleares`, `Illes Balears` and `Balearic Islands` rows, a Zamora one `Zamora` alone.
 * The languages come from the codex — the country's official languages plus the province's co-official
 * ones — and never from the names table's own language list, whose "preferred" name in a language
 * not spoken in the province is often the parent community's (`Zamora` → `Castella i Lleó`).
 */
export async function readTriplesFromParentJoin(
	countries: readonly string[],
	options: { postcodeDB?: PathBuilderLike; adminDB?: PathBuilderLike } = {}
): Promise<PostcodeTriple[]> {
	const postcodeDB = options.postcodeDB ?? wofDatabasePath("postalcode-intl.db")
	const adminDB = options.adminDB ?? wofDatabasePath("admin-global-priority-importance.db")

	await assertPathExists(postcodeDB, `readTriplesFromParentJoin: no postcode database at ${postcodeDB}`)
	await assertPathExists(adminDB, `readTriplesFromParentJoin: no admin gazetteer at ${adminDB}`)

	using db = new DatabaseClient<WOFDatabase>(adminDB, { readOnly: true })

	db.exec(`ATTACH DATABASE '${escapeSQLString(postcodeDB.toString())}' AS pc`)

	const statement = db.prepare(`
		SELECT p.name AS postcode, a.id AS locality_id, a.name AS locality, r.id AS region_id, r.name AS region,
		       c.name AS country, p.country AS cc
		FROM pc.spr p
		JOIN spr a ON a.id = p.parent_id AND a.placetype IN ('locality', 'localadmin')
		JOIN ancestors anc ON anc.id = a.id AND anc.ancestor_placetype = 'region'
		JOIN spr r ON r.id = anc.ancestor_id
		JOIN ancestors cnc ON cnc.id = a.id AND cnc.ancestor_placetype = 'country'
		JOIN spr c ON c.id = cnc.ancestor_id
		WHERE p.country = ? AND p.parent_id > 0
		ORDER BY p.id
	`)

	const surfaces = createSurfaceReader(db)
	const out: PostcodeTriple[] = []

	for (const cc of countries) {
		const convention = POSTCODE_CONVENTIONS.get(cc)

		if (!convention) continue

		for (const row of statement.all(cc) as Array<{
			postcode: string | null
			locality_id: number
			locality: string | null
			region_id: number
			region: string | null
			country: string | null
		}>) {
			if (!row.postcode || !row.locality || !row.region) continue

			const locality = surfaces.locality(cc, row.locality_id, row.locality)

			for (const region of surfaces.region(cc, row.region_id, row.region)) {
				out.push({
					postcode: row.postcode,
					locality,
					region,
					country: row.country ?? "",
					cc,
					locale: convention.locale,
					postcodePlacement: convention.placement,
				})
			}
		}
	}

	return out
}

/**
 * Reads the surfaces a place is written as, against one open admin gazetteer,
 * caching each place's preferred names by id so a gazetteer walk that meets a
 * region once per locality reads it once in total.
 */
interface SurfaceReader {
	/**
	 * Every surface the region is written as, in the order {@link regionWrittenForms} defines.
	 */
	region: (cc: string, id: number, sprName: string) => string[]
	/**
	 * The one surface the locality is written as.
	 *
	 * See {@link localityWrittenForm} for why it is one and not a fan-out.
	 */
	locality: (cc: string, id: number, sprName: string) => string
}

/**
 * Bind {@link regionWrittenForms} and {@link localityWrittenForm} to an open gazetteer.
 *
 * Both extractions below reach the same two questions from different starting rows —
 * one walks up from a postcode, the other down from a country — so the preferred-name read,
 * its per-id cache and the codex language selection live here rather than in each caller.
 * The languages come from the codex and never from the names table's own language list,
 * whose "preferred" name in a language not spoken in the region is often the
 * parent's (`Zamora` → `Castella i Lleó`).
 */
function createSurfaceReader(db: DatabaseClient<WOFDatabase>): SurfaceReader {
	const preferredStatement = db.prepare(
		`SELECT language, name FROM names WHERE id = ? AND privateuse = 'preferred' AND language IS NOT NULL ORDER BY language, name`
	)

	const preferredByID = new Map<number, Map<string, string[]>>()

	const preferredNames = (id: number): Map<string, string[]> => {
		let byLanguage = preferredByID.get(id)

		if (!byLanguage) {
			byLanguage = new Map()

			for (const row of preferredStatement.all(id) as Array<{ language: string; name: string }>) {
				const list = byLanguage.get(row.language) ?? []

				list.push(row.name)
				byLanguage.set(row.language, list)
			}

			preferredByID.set(id, byLanguage)
		}

		return byLanguage
	}

	const namesIn = (byLanguage: Map<string, string[]>, languages: readonly string[]): string[] =>
		languages.flatMap((language) => byLanguage.get(language) ?? [])

	return {
		region(cc, id, sprName) {
			const officialLanguages = officialLanguagesAlpha3(cc)
			const official = namesIn(preferredNames(id), officialLanguages)
			// The co-official table is keyed by the region's name in the first official language.
			// A region the names table has no such name for is looked up by its `spr.name`,
			// which for a monolingual country is the same string.
			const regionLanguages = regionLanguagesAlpha3(cc, official[0] ?? sprName)
			const coOfficialLanguages = regionLanguages.filter((language) => !officialLanguages.includes(language))

			return regionWrittenForms(sprName, { official, coOfficial: namesIn(preferredNames(id), coOfficialLanguages) })
		},
		locality(cc, id, sprName) {
			const official = namesIn(preferredNames(id), officialLanguagesAlpha3(cc))

			return localityWrittenForm(sprName, { official, coOfficial: [] })
		},
	}
}

/**
 * One extracted `(locality, region, country)` pair, carrying no postcode.
 */
export type AdminPair = Omit<PostcodeTriple, "postcode" | "postcodePlacement">

/**
 * Read `(locality, region, country)` pairs for a country straight from the
 * admin gazetteer, with no postcode.
 *
 * The postcode-containing readers each need a source that pairs a code with a place,
 * and for a country that publishes no such source there is no row they can return.
 * Canada is the worked example: GeoNames publishes 1,657 CA rows, every postcode a three-character FSA
 * and column 3 an area label (`Vancouver (North Grandview-Woodlands)`) rather than a locality,
 * while `postalcode-ca-overture.db` carries 843,739 full codes with `parent_id = -1` on every row.
 *
 * Neither reader yields a single CA tuple, so `trailing-region`'s Canadian
 * region-code surface has never had one to act on.
 *
 * The admin gazetteer answers the pair without a postcode — 12,995 CA localities carry
 * a region ancestor — and the recipe's bare form needs no postcode.
 * That form is what the failure reads on: `St. John's, NL, Canada` answers
 * `country: NL` (the Netherlands) with `Canada` dropped, because `NL` is a curated
 * country surface form and no row attests it as a region.
 *
 * A pair per region surface, the same rule {@link readTriplesFromParentJoin} follows.
 * No postcode is synthesized: a postcode asserts a fact about a place
 * and a locality's own is not derivable from this source.
 */
export async function readPairsFromAdmin(
	countries: readonly string[],
	options: { adminDB?: PathBuilderLike; locale?: (cc: string) => string } = {}
): Promise<AdminPair[]> {
	const adminDB = options.adminDB ?? wofDatabasePath("admin-global-priority-importance.db")

	await assertPathExists(adminDB, `readPairsFromAdmin: no admin gazetteer at ${adminDB}`)

	using db = new DatabaseClient<WOFDatabase>(adminDB, { readOnly: true })

	const statement = db.prepare(`
		SELECT a.id AS locality_id, a.name AS locality, r.id AS region_id, r.name AS region, c.name AS country
		FROM spr a
		JOIN ancestors anc ON anc.id = a.id AND anc.ancestor_placetype = 'region'
		JOIN spr r ON r.id = anc.ancestor_id
		JOIN ancestors cnc ON cnc.id = a.id AND cnc.ancestor_placetype = 'country'
		JOIN spr c ON c.id = cnc.ancestor_id
		WHERE a.country = ? AND a.placetype IN ('locality', 'localadmin') AND a.is_current != 0 AND a.is_deprecated = 0
		ORDER BY a.id
	`)

	const surfaces = createSurfaceReader(db)
	const out: AdminPair[] = []

	for (const cc of countries) {
		const locale = options.locale?.(cc) ?? "und"

		for (const row of statement.all(cc) as Array<{
			locality_id: number
			locality: string | null
			region_id: number
			region: string | null
			country: string | null
		}>) {
			if (!row.locality || !row.region) continue

			const locality = surfaces.locality(cc, row.locality_id, row.locality)

			for (const region of surfaces.region(cc, row.region_id, row.region)) {
				// A pair whose region repeats its locality carries no signal about the boundary
				// the recipe exists for, and the recipe drops it anyway — dropping it here
				// keeps the country budget from being spent on rows that vanish.
				if (region === locality) continue

				out.push({ locality, region, country: row.country ?? "", cc, locale })
			}
		}
	}

	return out
}

/**
 * A predicate answering whether a name is a locality the admin gazetteer knows, for one country.
 *
 * The parent-join reader gets this for free.
 * Its query restricts the parent to `locality`/`localadmin`, so every name it emits is one by construction.
 *
 * The GeoNames reader has no such guarantee, and the gap is large enough to matter:
 * sampling 400 rows per country against the gazetteer, the share of GeoNames place
 * names that name a locality we know is PT 75%, IN 62%, **MX 41%**.
 * The Mexican misses are colonias — `Zona Centro`, `San Fernando infonavit`,
 * `fovissste 3a Sección` — and a row teaching one of those as `locality` trains the
 * locality/dependent_locality boundary in the wrong direction.
 *
 * Dropping the row instead costs coverage and teaches no falsehood, which is the better of the two.
 *
 * @throws When the gazetteer is not on disk.
 * A predicate that accepted every name would emit the unfiltered rows as though the filter had run.
 */
export async function createKnownLocalityCheck(
	country: string,
	adminDB?: PathBuilderLike
): Promise<(name: string) => boolean> {
	const path = adminDB ?? wofDatabasePath("admin-global-priority-importance.db")

	await assertPathExists(path, `createKnownLocalityCheck: no admin gazetteer at ${path}`)

	using db = new DatabaseClient<WOFDatabase>(path, { readOnly: true })

	const names = new Set<string>()

	for (const row of db
		.prepare("SELECT name FROM spr WHERE country = ? AND placetype IN ('locality', 'localadmin')")
		.all(country) as Array<{ name: string | null }>) {
		if (row.name) {
			names.add(row.name.toLowerCase())
		}
	}

	// An empty set means the gazetteer has no localities for this country at all,
	// which is a coverage fact about the gazetteer rather than a verdict on the source .
	// Therefore, check no entry rather than drop everything.
	if (!names.size) return () => true

	return (name: string) => names.has(name.toLowerCase())
}

/**
 * Read triples straight out of a GeoNames `<CC>.txt` export.
 * No join, the names are columns 3 and 4.
 *
 * Column 3 is not the locality.
 * It is the finest-grained named place for the code, and for `560001` that is
 * `Mahatma Gandhi Road` — a street — while the city, `Bengaluru`, is column 5 (admin2).
 *
 * MX is the same shape (`Roma Norte` is a colonia inside `Cuauhtémoc`) and
 * so is PT (`Abrigada` inside `Alenquer`).
 * Reading column 3 as the locality is how the v4.8.0 recipe output came to teach street names as cities.
 *
 * So `admin2` is the locality, `admin1` the region, and column 3 the dependent locality,
 * which is also the left context the recipe needs.
 *
 * Which countries this reader can serve.
 * It needs `admin2` (the city) and `admin1` (the region), and a country can publish one without the other.
 *
 * Measured 2026-08-23 across the exports on disk:
 *
 * | country    | rows      | admin1 | admin2 | usable here                     |
 * | ---------- | --------: | -----: | -----: | ------------------------------- |
 * | PT, MX, IN | 145k–207k | 100%   | 100%   | yes                             |
 * | BD, LK     | 1.3k–1.8k | 100%   | 100%   | yes                             |
 * | PH         | 2,317     | 88%    | 88%    | yes, 88% of rows                |
 * | PK         | 2,563     | 100%   | **0%** | no — no city column             |
 * | TH         | 903       | 100%   | **1%** | no — effectively no city column |
 * | ID         | 81,058    | **0%** | 0%     | no — no region either           |
 * | ZA         | 3,920     | **0%** | —      | no                              |
 *
 * A country whose row above reads `no` yields zero from this reader, and that is the
 * correct outcome rather than a gap to route around: taking column 3 as the locality is
 * what made the v4.8.0 recipe output train `Mahatma Gandhi Road` as a city.
 * If one of them is wanted, it needs a city column from somewhere else rather than a relaxed mapping.
 *
 * Not published AT all by GeoNames, checked the same day: VE, VN, NP, MM, KH.
 * Those are acquisition questions, and for VE specifically OpenAddresses 404s too —
 * see the arc retrospective.
 *
 * Three source properties a caller cannot see from a row count, all handled here.
 * Hyphen-format countries publish each code twice (`3750-000` and `3750000`, exactly 2.00× for PT and PL),
 * so the first surface of a code wins and its twin is dropped.
 *
 * Some countries populate the place but not admin1 — ZA is 100% place, 0% region — which yields no
 * value this recipe can use, so those rows are dropped rather than emitted with a blank region.
 * And the "place name" is often a SUB-locality, which {@link createKnownLocalityCheck} filters.
 */
export async function readTriplesFromGeonames(
	country: string,
	path: PathBuilderLike,
	countryName: string,
	options: { isKnownLocality?: (name: string) => boolean } = {}
): Promise<PostcodeTriple[]> {
	const convention = POSTCODE_CONVENTIONS.get(country)

	if (!convention) return []

	await assertPathExists(path, `readTriplesFromGeonames: no GeoNames postal export at ${path}`)

	const isKnownLocality = options.isKnownLocality ?? (await createKnownLocalityCheck(country))
	const out: PostcodeTriple[] = []
	const seen = new Set<string>()

	// Which column the city sits in is a property of the country's export —
	// see {@link GeonamesLocalityColumn}.
	// The other column becomes the dependent locality, which is a sub-locality
	// for PT/MX/IN and a county for the US.
	const localityIsPlace = convention.localityColumn === "place"

	for await (const cells of TSVSpliterator.fromAsync(path, { header: false }) as AsyncIterable<string[]>) {
		const postcode = (cells[GEONAMES_POSTAL_COLUMNS.postcode] ?? "").trim()
		const place = (cells[GEONAMES_POSTAL_COLUMNS.place] ?? "").trim()
		const admin2 = (cells[GEONAMES_POSTAL_COLUMNS.admin2Name] ?? "").trim()
		const locality = localityIsPlace ? place : admin2
		const dependentLocality = localityIsPlace ? "" : place
		const region = (cells[GEONAMES_POSTAL_COLUMNS.admin1Name] ?? "").trim()

		if (!postcode || !locality || !region) continue

		// The check applies to the locality rather than to the other column, which for PT/MX/IN is expected
		// to be a street or a colonia and is emitted as the dependent locality rather than dropped.
		// A US county is not emitted as a dependent locality: it is an administrative tier the
		// address line does not write, and teaching it as one would attest a segment nobody types.
		if (!isKnownLocality(locality)) continue

		// A dependent locality that merely repeats its parent teaches a doubled segment rather than a boundary.
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
export function geonamesPostalPath(country: string, sourcesRoot?: PathBuilderLike): PathBuilder {
	return PathBuilder.from(sourcesRoot ?? dataRootPath("corpus", "sources"))(
		"geonames-postal",
		`${country.toUpperCase()}.txt`
	)
}
