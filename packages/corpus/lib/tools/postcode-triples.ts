/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Extract `(postcode, locality, region, country)` tuples for the `trailing-region` recipe.
 *
 * Each tuple is stamped with its country's {@link PostcodePlacement}, because the same digits change tag with position.
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
	 * A recipe output whose every row begins with the locality teaches that the
	 * first named segment is the locality.
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
 * `admin2` is the default; for the US it is the inverse, because column 3 is the city
 * and admin2 the county, so taking the default would train counties as cities.
 */
export type GeonamesLocalityColumn = "place" | "admin2"

/**
 * Where a country writes the postcode, and the locale tag its rows carry.
 *
 * A country is in this table only when a gauntlet board row attests its surface, because extracting
 * an absent country with the wrong placement teaches a convention that country does not use.
 */
export const POSTCODE_CONVENTIONS: ReadonlyMap<
	string,
	{ placement: PostcodePlacement; locale: string; localityColumn?: GeonamesLocalityColumn }
> = new Map([
	// `Rue de l'Église, 3, 29217 Plougonvelin, Bretagne, France` and its siblings in
	// the structured slices attest this leading placement.
	["FR", { placement: "leading", locale: "fr-FR" }],
	["DE", { placement: "leading", locale: "de-DE" }],
	["ES", { placement: "leading", locale: "es-ES" }],
	["IT", { placement: "leading", locale: "it-IT" }],
	["NL", { placement: "leading", locale: "nl-NL" }],
	["PT", { placement: "leading", locale: "pt-PT" }],
	["MX", { placement: "leading", locale: "es-MX" }],
	// No postcode source on disk and GeoNames does not publish VE, so this entry yields no row;
	// it is here because the placement makes the absence legible.
	["VE", { placement: "after_locality", locale: "es-VE" }],
	// `12 MG Road, Indiranagar, Bengaluru, Karnataka 560038, India` — three `in_*` rows,
	// the one trailing placement with real data behind it.
	["IN", { placement: "after_region", locale: "en-IN" }],
	// Attested by the four `us_city_state_postcode` board rows; `localityColumn` keeps it from training counties.
	["US", { placement: "after_region", locale: "en-US", localityColumn: "place" }],
	// The two `br_*` rows carry locality, region and CEP in that order; the default `admin2` column
	// is right here, because BR's export writes the municipality in column 3 and admin2 alike.
	["BR", { placement: "after_region", locale: "pt-BR" }],
])

/**
 * How many postcodes one locality may contribute.
 *
 * A quota rather than a cutoff: it bounds repetition without deleting a locality.
 */
export const DEFAULT_LOCALITY_QUOTA = 24

/**
 * Take at most `quota` tuples per locality, in the order they arrive.
 *
 * Both readers walk their source in id/file order, which is stable across runs,
 * so the same quota selects the same rows.
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
 * Applied after {@link applyLocalityQuota}, and spent BY region in rounds so a cap
 * smaller than the source still reaches every region rather than one corner.
 * `subKey` adds a second round-robin dimension so the budget spreads across `(region, subKey)`.
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
 * The surfaces a region is written as: its preferred names in the official language(s),
 * then the region's co-official languages, then the gazetteer's own `spr.name`
 * (the English exonym), deduplicated with order kept.
 *
 * Reading `spr.name` alone teaches stripped exonyms (`Balearic Islands`, `Cordoba`)
 * against the forms a user writes.
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
 * The separator Who's On First joins a region's two co-official names with; spaces are required
 * on both sides, because a slash with no surrounding spaces appears inside single names.
 */
const BILINGUAL_JOINED = / \/ /

/**
 * The provincial generic Who's On First keeps in a province's Catalan and Asturian
 * preferred names, dropped so the surface dedupes against the Castilian one.
 */
const PROVINCE_GENERIC = /^prov[ií]ncia (?:de |d')/iu

/**
 * The surface a locality is written as: the official-language preferred name matching
 * `spr.name` folded, else the first official-language name, else `spr.name`.
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
 * Reads the surfaces a place is written as against one open admin gazetteer, caching each
 * place's preferred names by id so a region met once per locality is read once in total.
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
 * The languages come from the codex rather than the names table's own language list,
 * whose "preferred" name in a language not spoken in the region is often the parent's.
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
			// The co-official table is keyed by the region's name in the first official language;
			// a region the names table has no such name for is looked up by its `spr.name`,
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
 * A pair per region surface, the same rule {@link readTriplesFromParentJoin} follows,
 * and no postcode is synthesized.
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
 * The parent-join reader gets this for free; the GeoNames reader does not, and a row teaching
 * a colonia as `locality` trains the locality/dependent_locality boundary the wrong way.
 *
 * @throws When the gazetteer is not on disk, because a predicate that accepted every
 * name would emit unfiltered rows as though the filter had run.
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

	// An empty set is a coverage fact about the gazetteer rather than a verdict on the source,
	// so accept every name rather than dropping everything.
	if (!names.size) return () => true

	return (name: string) => names.has(name.toLowerCase())
}

/**
 * Read triples straight out of a GeoNames `<CC>.txt` export, with no join.
 *
 * `admin2` is the locality, `admin1` the region, and column 3 the dependent locality,
 * because reading column 3 as the locality is what taught `Mahatma Gandhi Road` as a city.
 * A country whose export lacks admin1 or admin2 yields zero from this reader,
 * which is correct rather than a gap to route around.
 *
 * Hyphen-format countries publish each code twice, so the first surface of a code wins.
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
	// see {@link GeonamesLocalityColumn}; the other column becomes the dependent locality,
	// a sub-locality for PT/MX/IN and a county for the US.
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
