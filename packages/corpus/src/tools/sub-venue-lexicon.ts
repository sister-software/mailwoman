/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   @file Build the sub-venue designator lexicon (#35) — the vocabulary a corpus shard and, eventually,
 *   the span proposer read to recognize `Terminal 5`, `North Terminal`, `Concourse B`, `ターミナル1` as
 *   venue-INTERIOR structure. This is the assembly: the record schema lives in `sub-venue/table.ts`, the
 *   implementation in its siblings, and the curation decisions in `sub-venue-promotions.ts`.
 *
 *   Reads the fetch outputs (`mailwoman corpus fetch wikidata-subvenue`, a JSONL of
 *   `@mailwoman/osm/sdk`'s `SubVenueSourceRow`s per region, and the Overture slice of `poi.db` via
 *   `overture-subvenue.ts`) and emits one committed JSON table.
 *
 *   ── Determinism ──────────────────────────────────────────────────────────────────────────────────
 *   {@link buildSubVenueLexicon} is a PURE function of its inputs with a stable sort on every array, so
 *   a regenerate against the same fetch outputs is byte-identical. No timestamp is emitted for the same
 *   reason `taxonomy.json` carries none — a clock in the artifact makes every regenerate a diff.
 *   Vintages live in `sources[]`, taken from the fetch manifests.
 *
 *   ── Where the stages live ────────────────────────────────────────────────────────────────────────
 *   Each stage carries the measurements that shaped it; the order they run in is
 *   {@link buildSubVenueLexicon}'s own docstring, and it is required.
 *
 *   - `sub-venue/table.ts` — the emitted record schema plus the shipped seed vocabulary.
 *   - `sub-venue/surfaces.ts` — phrase normalization, the phrase → record index, and the name-match
 *     operator that gates the harvest.
 *   - `sub-venue/wikidata.ts` — the designator-label SPARQL payload turned into surfaces.
 *   - `sub-venue/head-nouns.ts` — the addressed form derived from an encyclopaedic label.
 *   - `sub-venue/harvest.ts` — the harvestable row shape, its JSONL reader, and the attestation pass.
 *
 *   ── What `curated: false` means, and how a surface stops being it ────────────────────────────────
 *   Every machine-derived surface lands `curated: false`, and {@link SubVenueLexiconTable} consumers
 *   that gate parsing MUST filter to `curated: true`. A surface becomes curated ONLY by matching a
 *   {@link SubVenuePromotion} in `sub-venue-promotions.ts` — a per-designator, per-LOCALE decision
 *   carrying the census that backs it. Promotion is per-locale because the same token is a designator in
 *   one language and a disaster in another: `hall` is `Halle 2` at Frankfurt and `Village Hall` at 3,205
 *   British bus stops.
 */

import { parseJSONStrict } from "@mailwoman/core/objects"
import { readFileSync, statSync, writeFileSync } from "@mailwoman/platform/fs"
import { basename, join } from "@mailwoman/platform/path"

import { SUBVENUE_PROMOTIONS, type SubVenuePromotion } from "./sub-venue-promotions.ts"
import { extractAttestedPhrases, readSubVenueJSONL, type SubVenueHarvestRow } from "./sub-venue/harvest.ts"
import { deriveHeadNounSurfaces } from "./sub-venue/head-nouns.ts"
import { buildSurfaceIndex } from "./sub-venue/surfaces.ts"
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
} from "./sub-venue/table.ts"
import { surfacesFromWikidata } from "./sub-venue/wikidata.ts"

export * from "./sub-venue/harvest.ts"
export * from "./sub-venue/head-nouns.ts"
export * from "./sub-venue/surfaces.ts"
export * from "./sub-venue/table.ts"
export * from "./sub-venue/wikidata.ts"

/**
 * Apply the curation decisions to a surface list, IN PLACE on a copy.
 *
 * A promotion binds `(designatorID, phrase, locale)`. A surface matches when it names the same record with the same
 * phrase and its language is the locale's language OR the untagged `und` — the default `name` tag carries no language,
 * and a German extract's untagged `Halle 2` is German.
 *
 * REGION is the subtle half. A surface attested in an extract carries that extract's region and matches only its own
 * locale. A surface with `region: ""` is region-FREE — a Wikidata label or a derived head noun — and a promotion
 * reaches it only when no REJECTION exists for the same designator, phrase and language anywhere else. That guard is
 * not decoration: `pier` is promoted for en-GB and rejected for en-US, and without it the en-GB decision would curate
 * the region-free English surface and hand `Pier 1 Imports` the promotion en-US was refused. Where no rejection
 * competes — `terminal` in `es`, `ターミナル` in `ja` — the region-free surface is the whole point, since a language's
 * designator does not stop at a border.
 *
 * Rejections mark nothing themselves. They exist in `promotions[]` as the record of a decision taken, so the next
 * reader meets en-GB `hall`'s 3,204 bus stops before re-proposing it, not after.
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
 * One harvestable input: rows plus the stamp they carry into the table.
 */
export interface SubVenueHarvest {
	rows: readonly SubVenueHarvestRow[]
	source?: string
	region?: string
}

/**
 * Everything {@link buildSubVenueLexicon} needs, already parsed. Keeping the builder off the filesystem is what makes it
 * deterministic and testable without fixtures on disk.
 */
export interface BuildSubVenueLexiconInput {
	/**
	 * The raw `designator-labels.json` SPARQL envelope, or `null` to build the seed-only table.
	 */
	wikidata: unknown | null
	/**
	 * Every harvestable source, in the order they should contribute. Order matters only for the surface INDEX: a source
	 * can match a phrase an earlier source introduced, never a later one.
	 */
	harvests: readonly SubVenueHarvest[]
	/**
	 * Provenance rows, copied off the fetch manifests by the caller.
	 */
	sources: readonly SubVenueLexiconSource[]
	/**
	 * Curation decisions. Defaults to the committed {@link SUBVENUE_PROMOTIONS}; pass an empty array to build the
	 * pre-curation table (which is what the promotion census itself is taken against).
	 */
	promotions?: readonly SubVenuePromotion[]
}

/**
 * Build the lexicon table. PURE and deterministic — same inputs, byte-identical output.
 *
 * Order of operations is required in three places:
 *
 * 1. Seed surfaces are inserted before anything else, so `terminal` indexes to the `terminal` designator rather than to
 *    whichever Wikidata alias sorts first.
 * 2. Head nouns are derived AFTER Wikidata and BEFORE the harvests, because `ターミナル` has to exist as a surface before a
 *    Japanese extract can be searched for it. That ordering is the entire reason the Japan harvest finds anything — see
 *    `PROVENANCE.md`.
 * 3. Promotions are applied LAST, over the union, so a decision can promote a surface whichever source produced it.
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

	// A Wikidata concept id is provenance for the designator it names, whether or not the concept
	// contributed a usable surface.
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
			// The English designator IS the shipped vocabulary — curated by construction.
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

	// Deterministic order everywhere. `localeCompare` matches the tie-break discipline
	// `generate-taxonomy.ts` and `build-brands.ts` already use.
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
 * Serialize the table the way the committed artifact stores it: pretty-printed, trailing newline. Run `oxfmt` over the
 * result before committing — repo law is that committed JSON is oxfmt-clean, which `JSON.stringify` cannot reproduce.
 */
export function serializeSubVenueLexicon(table: SubVenueLexiconTable): string {
	return JSON.stringify(table, null, 2) + "\n"
}

/**
 * The Wikidata fetch manifest's shape, narrowed to the fields the lexicon copies into `sources[]`.
 */
interface WikidataFetchManifest {
	endpoint?: string
	license?: string
	downloaded_at?: string
	files?: Array<{ filename?: string; rows?: number }>
}

/**
 * One OSM extract to harvest: the JSONL path plus the ISO country its rows describe.
 */
export interface SubVenueExtractInput {
	path: string
	region: string
}

export interface GenerateSubVenueLexiconOptions {
	/**
	 * Directory holding the `mailwoman corpus fetch wikidata-subvenue` output. Omit to build the seed-only table.
	 */
	wikidataDir?: string
	/**
	 * OSM extract JSONLs, one per region.
	 */
	extracts?: readonly SubVenueExtractInput[]
	/**
	 * Already-read Overture rows (`readOvertureSubVenues`), grouped by the caller. Kept as a parameter rather than a path
	 * so this function stays free of a 3.9 GB database dependency — the CLI opens `poi.db`, this assembles.
	 */
	overtureRows?: readonly (SubVenueHarvestRow & { country: string })[]
	/**
	 * `poi.db`'s layer vintage, for `sources[]`. Only read when `overtureRows` is non-empty.
	 */
	overtureVintage?: string
	/**
	 * Where the table is written.
	 */
	outPath: string
}

/**
 * Read the fetch outputs, build the table, and write it.
 *
 * The IO half only — every decision lives in {@link buildSubVenueLexicon}, which is pure. Run `oxfmt` over `outPath`
 * afterwards; repo law is that committed JSON is oxfmt-clean.
 */
export function generateSubVenueLexicon(options: GenerateSubVenueLexiconOptions): SubVenueLexiconTable {
	const sources: SubVenueLexiconSource[] = []
	const harvests: SubVenueHarvest[] = []
	let wikidata: unknown = null

	if (options.wikidataDir) {
		wikidata = parseJSONStrict<unknown>(readFileSync(join(options.wikidataDir, "designator-labels.json"), "utf8"))

		const manifest = parseJSONStrict<WikidataFetchManifest>(
			readFileSync(join(options.wikidataDir, "MANIFEST.json"), "utf8")
		)

		const labelFile = manifest.files?.find((f) => f.filename === "designator-labels.json")

		sources.push({
			id: "wikidata",
			origin: manifest.endpoint ?? "https://query.wikidata.org/sparql",
			license: manifest.license ?? "CC0",
			// The DATE only. A full ISO timestamp would make every re-fetch a diff in the committed artifact for
			// no information a reader of a vocabulary table can act on.
			retrieved: (manifest.downloaded_at ?? "").slice(0, 10),
			rows: labelFile?.rows ?? 0,
		})
	}

	for (const extract of options.extracts ?? []) {
		const rows = readSubVenueJSONL(extract.path)

		harvests.push({ rows, source: "osm", region: extract.region })

		sources.push({
			id: `osm:${extract.region.toLowerCase()}`,
			// The extract's NAME, never its path. `AGENTS.md` forbids re-hardcoding the lab data root
			// anywhere, and a committed artifact carrying `/mnt/playpen/...` would do exactly that while
			// telling a reader on another machine nothing. `great-britain` identifies the Geofabrik region,
			// which is the fact that matters.
			origin: `OpenStreetMap via Geofabrik (${basename(extract.path, ".jsonl")})`,
			license: "ODbL (OpenStreetMap)",
			// The extract's mtime — when the rows were produced. `corpus/AGENTS.md`'s standing warning that
			// a file's mtime is not its DATA's vintage applies to a downloaded archive; this file is a build
			// output of ours, so its mtime is exactly the right number.
			retrieved: statSync(extract.path).mtime.toISOString().slice(0, 10),
			rows: rows.length,
		})
	}

	if (options.overtureRows?.length) {
		// Overture rows carry their own country, so they are harvested per REGION rather than in one pass —
		// a `region` on the surface is the axis promotion is decided on and a mixed-country bucket would
		// make it meaningless.
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
	writeFileSync(options.outPath, serializeSubVenueLexicon(table))

	return table
}
