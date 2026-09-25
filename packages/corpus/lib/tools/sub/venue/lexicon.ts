/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   @file Builds the sub-venue designator lexicon from Wikidata, OSM and Overture fetch outputs.
 */

import { readLocalJSONFile, statPath } from "@mailwoman/core/fs/readers"
import { writeLocalFile } from "@mailwoman/core/fs/writers"
import { prettyJSON } from "@mailwoman/core/json"
import { isoDate } from "@mailwoman/core/utils"
import { basename, PathBuilder, type PathBuilderLike } from "path-ts"

import { extractAttestedPhrases, readSubVenueJSONL, type SubVenueHarvestRow } from "#tools/sub/venue/harvest"
import { deriveHeadNounSurfaces } from "#tools/sub/venue/head-nouns"
import { SUBVENUE_PROMOTIONS, type SubVenuePromotion } from "#tools/sub/venue/promotions"
import { buildSurfaceIndex } from "#tools/sub/venue/surfaces"
import {
	CONCEPT_QIDS,
	type IdentifierShape,
	LexiconTier,
	PROPOSED_DESIGNATORS,
	SHIPPED_DESIGNATOR_SEED,
	SHIPPED_MODIFIER_SEED,
	type SubVenueDesignator,
	type SubVenueLexiconSource,
	type SubVenueLexiconTable,
	type SubVenueModifier,
	type SubVenueSurface,
	SUBVENUE_LEXICON_VERSION,
} from "#tools/sub/venue/table"
import { surfacesFromWikidata } from "#tools/sub/venue/wikidata"

export * from "#tools/sub/venue/harvest"
export * from "#tools/sub/venue/head-nouns"
export * from "#tools/sub/venue/surfaces"
export * from "#tools/sub/venue/table"
export * from "#tools/sub/venue/wikidata"

/**
 * Returns a copy of the surfaces with `curated: true` set on each surface that a promotion matches.
 *
 * A promotion matches a surface with the same record id and phrase whose language
 * is the promotion's language or `und`.
 * An extract surface must also come from the promotion's region.
 *
 * A surface without a region, such as a Wikidata label, matches only when no rejection
 * exists for the same designator, phrase and language in any region.
 * For example, `pier` is promoted for en-GB and rejected for en-US,
 * so the region-free English `pier` stays uncurated.
 *
 * Rejections never mark a surface.
 * They stay in the table as a record of the decision.
 */
export function applyPromotions(
	surfaces: readonly SubVenueSurface[],
	promotions: readonly SubVenuePromotion[]
): SubVenueSurface[] {
	const language = (locale: string): string => locale.split("-")[0]!
	const region = (locale: string): string => locale.split("-")[1] ?? ""

	const rejectedLanguages = new Set(
		promotions
			.filter((promotion) => promotion.decision === "reject")
			.map((promotion) => `${promotion.designatorID} ${promotion.phrase} ${language(promotion.locale)}`)
	)

	const promoted = promotions.filter((promotion) => promotion.decision === "promote")

	return surfaces.map((surface) => {
		if (surface.curated) return surface

		const hit = promoted.some((promotion) => {
			if (promotion.designatorID !== surface.recordID || promotion.phrase !== surface.phrase) return false

			const lang = language(promotion.locale)

			if (surface.lang !== lang && surface.lang !== "und") return false

			if (surface.region === region(promotion.locale)) return true

			return surface.region === "" && !rejectedLanguages.has(`${promotion.designatorID} ${promotion.phrase} ${lang}`)
		})

		return hit ? { ...surface, curated: true } : surface
	})
}

/**
 * One harvest input with the source and region stamped on its surfaces.
 */
export interface SubVenueHarvest {
	rows: readonly SubVenueHarvestRow[]
	source?: string
	region?: string
}

/**
 * The parsed inputs of {@link buildSubVenueLexicon}, which never reads the filesystem.
 */
export interface BuildSubVenueLexiconInput {
	/**
	 * The raw `designator-labels.json` SPARQL response, or `null` to build the seed-only table.
	 */
	wikidata: unknown | null
	/**
	 * The harvest inputs in contribution order.
	 *
	 * Each harvest can match only phrases that exist before it runs, including those from earlier harvests.
	 */
	harvests: readonly SubVenueHarvest[]
	/**
	 * Provenance rows that the caller copies from the fetch manifests.
	 */
	sources: readonly SubVenueLexiconSource[]
	/**
	 * The curation decisions, which default to {@link SUBVENUE_PROMOTIONS}.
	 *
	 * An empty array builds the uncurated table.
	 */
	promotions?: readonly SubVenuePromotion[]
}

/**
 * Builds the lexicon table deterministically, so identical inputs produce identical output.
 *
 * Three ordering rules apply:
 *
 * 1. Seed surfaces come first, so `terminal` indexes to the `terminal` designator
 *    instead of a Wikidata alias.
 * 2. Head nouns are derived after Wikidata and before the harvests, because a harvest
 *    can find only phrases such as `ターミナル` that already exist as surfaces.
 * 3. Promotions apply last, so they can curate a surface from any source.
 */
export function buildSubVenueLexicon(input: BuildSubVenueLexiconInput): SubVenueLexiconTable {
	const designators: SubVenueDesignator[] = SHIPPED_DESIGNATOR_SEED.map((seed) => ({
		id: seed.id,
		tier: LexiconTier.SubVenue,
		modifierEligible: seed.modifierEligible,
		shipped: true,
		provenance: [...seed.provenance],
	}))

	const byID = new Map(designators.map((d) => [d.id, d]))

	for (const proposed of PROPOSED_DESIGNATORS) {
		const existing = byID.get(proposed.id)

		if (existing) {
			existing.provenance = [...new Set([...existing.provenance, ...proposed.provenance])]

			continue
		}

		const record: SubVenueDesignator = {
			id: proposed.id,
			tier: proposed.tier,
			modifierEligible: false,
			shipped: false,
			provenance: [...proposed.provenance],
		}

		designators.push(record)
		byID.set(record.id, record)
	}

	// A designator records its Wikidata concept id even when the concept contributes no surface.
	for (const [id, qid] of Object.entries(CONCEPT_QIDS)) {
		const record = byID.get(id)

		if (record) {
			record.provenance = [...new Set([...record.provenance, `wikidata:${qid}`])]
		}
	}

	const modifiers: SubVenueModifier[] = SHIPPED_MODIFIER_SEED.map((id) => ({
		id,
		shipped: true,
		provenance: ["codex:directionals"],
	}))

	const surfaces: SubVenueSurface[] = [
		...designators.map((d): SubVenueSurface => ({
			phrase: d.id,
			recordID: d.id,
			recordKind: "designator",
			lang: "en",
			region: "",
			source: "seed",
			// Shipped English designators count as curated.
			curated: d.shipped,
			observations: 0,
			context: {},
		})),
		...modifiers.map((m): SubVenueSurface => ({
			phrase: m.id,
			recordID: m.id,
			recordKind: "modifier",
			lang: "en",
			region: "",
			source: "seed",
			curated: true,
			observations: 0,
			context: {},
		})),
	]

	if (input.wikidata) {
		surfaces.push(...surfacesFromWikidata(input.wikidata))
	}

	surfaces.push(...deriveHeadNounSurfaces(surfaces))

	const identifierShapes: IdentifierShape[] = []

	for (const harvest of input.harvests) {
		const attested = extractAttestedPhrases(harvest.rows, buildSurfaceIndex(surfaces), {
			source: harvest.source,
			region: harvest.region,
		})

		surfaces.push(...attested.surfaces)
		identifierShapes.push(...attested.identifierShapes)
	}

	const promotions = [...(input.promotions ?? SUBVENUE_PROMOTIONS)]
	const curated = applyPromotions(surfaces, promotions)

	// Every array is sorted so that the output is stable.
	designators.sort((a, b) => a.id.localeCompare(b.id))
	modifiers.sort((a, b) => a.id.localeCompare(b.id))

	curated.sort(
		(a, b) =>
			a.phrase.localeCompare(b.phrase) ||
			a.recordID.localeCompare(b.recordID) ||
			a.lang.localeCompare(b.lang) ||
			a.region.localeCompare(b.region) ||
			a.source.localeCompare(b.source)
	)

	return {
		version: SUBVENUE_LEXICON_VERSION,
		sources: input.sources.toSorted((a, b) => a.id.localeCompare(b.id)),
		designators,
		modifiers,
		surfaces: curated,
		identifierShapes: identifierShapes.toSorted(
			(a, b) =>
				a.designatorID.localeCompare(b.designatorID) ||
				a.region.localeCompare(b.region) ||
				a.shape.localeCompare(b.shape)
		),
		promotions: promotions.toSorted(
			(a, b) =>
				a.designatorID.localeCompare(b.designatorID) ||
				a.locale.localeCompare(b.locale) ||
				a.phrase.localeCompare(b.phrase)
		),
	}
}

/**
 * Serializes the table as pretty-printed JSON.
 *
 * Run `oxfmt` over the written file before committing, because committed JSON must match oxfmt's output.
 */
export function serializeSubVenueLexicon(table: SubVenueLexiconTable): string {
	return prettyJSON(table)
}

/**
 * The fields of the Wikidata fetch manifest that the lexicon copies into `sources[]`.
 */
interface WikidataFetchManifest {
	endpoint?: string
	license?: string
	downloaded_at?: string
	files?: Array<{ filename?: string; rows?: number }>
}

/**
 * One OSM extract to harvest, with the ISO country code of its rows.
 */
export interface SubVenueExtractInput {
	path: string
	region: string
}

/**
 * Options for {@link generateSubVenueLexicon}.
 */
export interface GenerateSubVenueLexiconOptions {
	/**
	 * The output directory of `mailwoman corpus fetch wikidata-subvenue`.
	 *
	 * Without it, the function builds the seed-only table.
	 */
	wikidataDir?: PathBuilderLike
	/**
	 * OSM extract JSONL files, one per region.
	 */
	extracts?: readonly SubVenueExtractInput[]
	/**
	 * Overture rows that the caller already read with `readOvertureSubVenues`.
	 *
	 * The caller opens `poi.db`, so this function does not depend on the database.
	 */
	overtureRows?: readonly (SubVenueHarvestRow & { country: string })[]
	/**
	 * The `poi.db` layer vintage, which is used only when `overtureRows` is non-empty.
	 */
	overtureVintage?: string
	/**
	 * The path of the written table.
	 */
	outPath: string
}

/**
 * Reads the fetch outputs, builds the table with {@link buildSubVenueLexicon}, and writes it.
 *
 * Run `oxfmt` over `outPath` afterwards, because committed JSON must match oxfmt's output.
 */
export async function generateSubVenueLexicon(options: GenerateSubVenueLexiconOptions): Promise<SubVenueLexiconTable> {
	const sources: SubVenueLexiconSource[] = []
	const harvests: SubVenueHarvest[] = []
	let wikidata: unknown = null

	if (options.wikidataDir) {
		const wikidataDir = PathBuilder.from(options.wikidataDir)

		wikidata = await readLocalJSONFile<unknown>(wikidataDir("designator-labels.json"))

		const manifest = await readLocalJSONFile<WikidataFetchManifest>(wikidataDir("MANIFEST.json"))

		const labelFile = manifest.files?.find((f) => f.filename === "designator-labels.json")

		sources.push({
			id: "wikidata",
			origin: manifest.endpoint ?? "https://query.wikidata.org/sparql",
			license: manifest.license ?? "CC0",
			// The table stores only the date so that a re-fetch on the same day produces no diff.
			retrieved: (manifest.downloaded_at ?? "").slice(0, 10),
			rows: labelFile?.rows ?? 0,
		})
	}

	for (const extract of options.extracts ?? []) {
		const rows = await readSubVenueJSONL(extract.path)

		harvests.push({ rows, source: "osm", region: extract.region })

		sources.push({
			id: `osm:${extract.region.toLowerCase()}`,
			// The origin records the Geofabrik region name, because a local path would leak the data root.
			origin: `OpenStreetMap via Geofabrik (${basename(extract.path, ".jsonl")})`,
			license: "ODbL (OpenStreetMap)",
			// The extract is a local build output, so its mtime is when its rows were produced.
			retrieved: isoDate((await statPath(extract.path)).mtime),
			rows: rows.length,
		})
	}

	if (options.overtureRows?.length) {
		// Promotions match on region, so the function harvests Overture rows one country at a time.
		const byCountry = new Map<string, SubVenueHarvestRow[]>()

		for (const row of options.overtureRows) {
			const bucket = byCountry.get(row.country) ?? []
			bucket.push(row)
			byCountry.set(row.country, bucket)
		}

		for (const [country, rows] of [...byCountry].toSorted((a, b) => a[0].localeCompare(b[0]))) {
			harvests.push({ rows, source: "overture", region: country })
		}

		sources.push({
			id: "overture",
			origin: "Overture Maps Foundation places, via the poi.db spatial layer",
			license: "CDLA-Permissive-2.0",
			retrieved: options.overtureVintage ?? "",
			rows: options.overtureRows.length,
		})
	}

	const table = buildSubVenueLexicon({ wikidata, harvests, sources })
	await writeLocalFile(serializeSubVenueLexicon(table), options.outPath)

	return table
}
