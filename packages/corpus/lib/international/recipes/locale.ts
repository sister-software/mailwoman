/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `locale` recipe — the multi-locale generalization of the `german` recipe. Reads real
 *   OpenAddresses tuples for a `--country` (DE/FR/NL/IT/ES), renders each via
 *   {@link renderLocaleRow} in both orders (`--intl-fraction`, default 0.4 international / the
 *   rest country-native), aligns to BIO, and emits a labeled jsonl. Generate-mode: it streams each
 *   source CSV (a streamed zip member for cached zips, plain `createReadStream` for extracted CSVs) and
 *   reservoir-samples to {@link RESERVOIR_CAP} (so FR/ES countrywide work in bounded memory), then
 *   draws `--count` rows from the pool with the passed `random`. Ported from the root build script
 *   it replaced.
 *
 *   The reservoir uses its own seeded prng ({@link makeMulberry32}, per part), independent of the
 *   emit `random`, so the input sample is reproducible without perturbing the synth/order draws.
 *
 *   surface diversity (#241): two per-country shape draws ride the emit loop, sized by the
 *   2026-07-02 format-diversity audit against the `openaddresses-{es,nl,it}-sample.jsonl` observed
 *   forms. ES: the OpenCage template comma-joins the house number (`calle mayor, 12`) but all 3,000
 *   eval rows space-join (`calle mayor 12`) — {@link ES_SPACE_JOIN_FRACTION} of native rows collapse
 *   the comma. NL: OA (and the eval, 3,000/3,000) glue the postcode (`1187LM`) while the national
 *   convention spaces it (`1187 LM`) — {@link NL_GLUED_POSTCODE_FRACTION} of rows keep the glued
 *   source shape, the rest the spaced conventional one. These draws are consumed only for their
 *   country, so DE/FR emit streams are unchanged for a given seed.
 */

import { COUNTRY_SURFACE_FORMS } from "@mailwoman/codex/country"
import { dataRootPath } from "@mailwoman/core/data-root"
import { openReadStream } from "@mailwoman/core/fs/streams"
import { readZipEntry } from "@mailwoman/core/fs/zip"
import { stringifyJSON } from "@mailwoman/core/json"
import { isPresent } from "@mailwoman/core/objects"
import { sample } from "@mailwoman/core/random"
import { mulberry32 as makeMulberry32 } from "@mailwoman/core/utils"
import type { PathBuilderLike } from "path-ts"
import { CSVSpliterator } from "spliterator"

import { stableSourceID } from "#adapters/utils"
import type { CorpusRecipe } from "#recipes/scaffold"
import { type LocaleBaseTuple, type RenderedLocaleRow, renderLocaleRow } from "#surfaces/locale"
import { alignRow } from "#utils"

/**
 * One per-country OA source part: either a cached `zip` + `csv` member (streamed out of the archive)
 * or an extracted plain `path` (streamed via `createReadStream`).
 *
 * Both carry the standard OA header (LON,LAT,number,street,unit,city,district,region,postcode,ID,hash).
 * An optional `region` fallback covers countries whose region column is empty
 * (DE — the Bundesland is implied by the per-state file).
 */
export interface LocalePart {
	zip?: PathBuilderLike
	csv?: string
	path?: PathBuilderLike
	region?: string
	/**
	 * NZ — the OA district column holds the city (`Auckland`) and city holds the suburb (`Birkenhead`).
	 *
	 * When set, map district→locality and city→dependent_locality
	 * (falling back to city→locality when district is empty, ~18% of NZ rows).
	 * Without this, the default city→locality mapping wrongly trains the suburb as the locality.
	 */
	districtAsLocality?: boolean
	/**
	 * ES pedanía part only — the header is the RAW (un-conformed) cnig export schema
	 * (`numero`, `tipo_vial`, `nombre_via`, `poblacion`, `municipio`, `comunidad_autonoma`, `cod_postal`),
	 * not the standard OA number/street/city/district/region/postcode header every other part uses.
	 *
	 * Verified 2026-07-22 by exact- coordinate cross-check: the OA-conformed `extracted/es/countrywide.csv`
	 * collapses city to `municipio` and drops `poblacion` (Spain's below-municipio núcleo/pedanía name)
	 * entirely, so this raw export is the only source for the pedanía signal.
	 * `street` is reconstructed as `tipo_vial + " " + nombre_via`
	 * (verified byte-identical to the conformed street column for the same row).
	 * City-analog = `poblacion`, district-analog = `municipio`.
	 */
	cnigRaw?: boolean
}

export interface LocaleCountrySource {
	source: string
	parts: LocalePart[]
	/**
	 * The `corpus_version` stamped on emitted rows.
	 *
	 * DE/FR keep the historical `0.4.0` (regenerating those recipe outputs must stay lineage-identical);
	 * ES/IT/NL are the #241 staging lineage (`v0.9.9-es-it-nl`).
	 */
	corpusVersion: string
	/**
	 * An alternate part list, read instead of {@link parts} when the `--district-as-locality`
	 * override is explicitly `true` for this invocation (see `run()`).
	 *
	 * ES-only for now — the standard `parts` entry can't supply real dependent-locality signal
	 * (its OA-conformed CSV drops `poblacion`; see {@link LocalePart.cnigRaw}), so the pedanía build
	 * reads a wholly different raw source instead of flipping the standard city/district columns.
	 * `undefined` for every other country.
	 *
	 * The override then just forces `districtAsLocality` on the normal `parts`, as GB/NZ already do per-part.
	 */
	pedaniaParts?: LocalePart[]
}

/**
 * Per-country OA sources + the source name used in the corpus.
 *
 * DE/FR read their historical build inputs, the cached zips under
 * `$MAILWOMAN_DATA_ROOT/oa-cache` — materialize them there to regenerate.
 * ES/NL read the extracted countrywide CSVs and IT the cached national zip under `$MAILWOMAN_DATA_ROOT`
 * (#241. The fresh ES extract is OA-conformed, so the old raw-cnig conform map is gone).
 *
 * DE carries a per-part `region` fallback (its region column is empty. The
 * international-order tail needs it, #327).
 * FR/NL/IT/ES region is populated per-row (ES = comunidad autónoma, IT = regione, NL = province).
 */
const COUNTRY_SOURCES: Record<string, LocaleCountrySource> = {
	DE: {
		source: "synth-german",
		corpusVersion: "0.4.0",
		parts: [
			{ zip: dataRootPath("oa-cache", "de__berlin.zip"), csv: "de/berlin.csv", region: "Berlin" },
			{ zip: dataRootPath("oa-cache", "de__sn__statewide.zip"), csv: "de/sn/statewide.csv", region: "Sachsen" },
		],
	},
	FR: {
		source: "synth-fr",
		corpusVersion: "0.4.0",
		parts: [{ zip: dataRootPath("oa-cache", "fr__countrywide.zip"), csv: "fr/countrywide.csv" }],
	},
	NL: {
		source: "synth-nl",
		corpusVersion: "0.9.9",
		parts: [{ path: dataRootPath("openaddresses", "extracted", "nl", "countrywide.csv") }],
	},
	IT: {
		source: "synth-it",
		corpusVersion: "0.9.9",
		parts: [{ zip: dataRootPath("oa-cache", "it__countrywide.zip"), csv: "it/countrywide.csv" }],
	},
	ES: {
		source: "synth-es",
		corpusVersion: "0.9.9",
		parts: [{ path: dataRootPath("openaddresses", "extracted", "es", "countrywide.csv") }],
		// Pedanía source (`synth-es-pedania`, `--district-as-locality`).
		// Reads the RAW (un-conformed) cnig export cached at oa-cache/es__countrywide.zip.
		// The `parts` CSV above lost `poblacion` in OA's own conform step (see {@link LocalePart.cnigRaw}).
		// districtAsLocality is pinned true here (this part only exists to be read pedanía-style);
		// the CLI override still applies harmlessly on top.
		pedaniaParts: [
			{
				zip: dataRootPath("oa-cache", "es__countrywide.zip"),
				csv: "es_addresses.csv",
				cnigRaw: true,
				districtAsLocality: true,
			},
		],
	},
	NZ: {
		// linz-derived OA countrywide extract (2.12M rows).
		// `districtAsLocality` inverts the city/district mapping: district holds the
		// city (Auckland), city the suburb (Birkenhead).
		// NZ OA carries no postcode.
		source: "synth-nz",
		corpusVersion: "0.9.9",
		// Eval holdout: a probe build excludes ~12% of NZ localities (a locality-bucket split)
		// for a source-disjoint coord board.
		// That split is a build-time concern (scratchpad), so the committed recipe reads the full CSV.
		parts: [{ path: dataRootPath("openaddresses", "extracted", "nz", "countrywide.csv"), districtAsLocality: true }],
	},
	GB: {
		// HM Land Registry Price Paid Data tuples (25.67M rows out of the PPD ingest).
		// PPD's district is the postal town (locality) and city is the dependent locality —
		// legitimately empty on the majority of rows (most GB addresses have no dependent locality).
		// `districtAsLocality` maps district→locality and, when present, city→dependent_locality.
		// The `readTuples` check above only drops a row when both are empty,
		// so the majority empty-city rows survive.
		source: "synth-gb",
		corpusVersion: "0.9.9",
		parts: [{ path: dataRootPath("ppd", "2026-07-22", "gb-tuples.csv"), districtAsLocality: true }],
	},
}

/**
 * Per-part reservoir cap.
 *
 * Streaming + Algorithm-R reservoir sampling to this size keeps memory bounded regardless of source
 * size, where buffering the whole CSV OOMs / overflows on FR/ES countrywide (~2.5 GB, ~25M rows).
 * DE/NL-scale sources (≤ ~1.2M) fit entirely, so they're sampled losslessly.
 */
const RESERVOIR_CAP = 1_200_000

/**
 * Fraction of native-order ES rows whose street→house join is space-collapsed
 * (`calle mayor 12`) instead of the template's comma (`calle mayor, 12`).
 *
 * Both are real Spanish surfaces.
 * The comma is the official convention, the space is what OA-derived feeds
 * (and all 3,000 `openaddresses-es-sample.jsonl` rows) carry. 0.5 teaches both.
 */
const ES_SPACE_JOIN_FRACTION = 0.5

/**
 * Fraction of NL rows whose postcode keeps OA's glued shape (`1187LM`)
 * instead of the spaced national convention (`1187 LM`).
 *
 * The eval sample is 100% glued.
 * The conventional spaced form is the `1012 LM` two-letter-suffix shape the model
 * currently glues onto the city (#241). 0.5 teaches both.
 */
const NL_GLUED_POSTCODE_FRACTION = 0.5

/**
 * OA city-noise normalization (#241) — the documented cleaning step, derived from the 2026-07-02
 * full-stream audit of the ES (15.6M rows), IT (13.9M), and NL (9.1M) sources (not a hand-list).
 *
 * Returns the cleaned city, or `null` to drop the tuple.
 *
 * Cleaned classes:
 *
 * 1. Drop pseudo-localities — the ES cadastral aggregates
 *    (`Comunidad de 09076, 09150 y 09578`, `Ledanía de …`; 0.06% of ES rows): any city containing
 *    a comma or a ≥4-digit run is a land-register aggregate rather than a renderable city.
 *    Structural, locale-safe — NL's genuine `2e Valthermond` (one digit) survives.
 *    IT/NL have zero hits.
 * 2. Strip a trailing parenthesized 1–3-letter admin code — the NL BAG province disambiguator
 *    (`Bergen (NH)`, `Rijswijk (GLD)` → `Bergen`, `Rijswijk`; 0.13% of NL rows).
 *    The analogue of the German Kreis/region-suffix class (#241 names `Rabenau Sachs` / `Weißwasser /O.L.`):
 *    an admin-region gloss glued onto the locality value that dirties locality labels.
 *
 * Audit-verified NON-noise, deliberately not cleaned (a naive suffix rule would mangle real names):
 *
 * - ES/IT city-ends-with-province (`Alhama de Almería`, `genzano DI roma`; ~0.8% each): genuine
 *   toponyms whose linking `de`/`di` makes them full names, unlike the German glued-abbreviation class.
 * - ES bilingual slash names (`Laudio/Llodio`; 2.16%): official co-names — the eval expects them verbatim.
 * - IT all-caps city casing (98.79% of the source, and the eval's observed form):
 *   casing is the #829 case-augmentation change rather than this recipe's.
 */
export function cleanCityNoise(city: string): string | null {
	if (/,|\d{4}/.test(city)) return null

	const stripped = city.replace(/\s*\(\p{L}{1,3}\)\s*$/u, "").trim()

	return stripped || null
}

interface ColumnIndex {
	num: number
	street: number
	city: number
	district: number
	region: number
	post: number
	/**
	 * {@link LocalePart.cnigRaw} only — the road-type column (`tipo_vial`) joined
	 * onto `street` (`nombre_via`). -1 otherwise.
	 */
	tipoVial: number
}

/**
 * Stream real tuples out of an OA source part and reservoir-sample to {@link RESERVOIR_CAP}.
 *
 * Reads the CSV row-by-row — `readZipEntry | CSVSpliterator` for zip parts,
 * `createReadStream | CSVSpliterator` for extracted parts (both bounded memory) — and keeps
 * a uniform random sample (Algorithm R) seeded by `rng`, separate from the emit loop's prng.
 * No global dedup (a 25M-key Set would OOM. OA rows are near-unique).
 *
 * The city passes through {@link cleanCityNoise}.
 * The region falls back to `part.region` when the row's region cell is empty (DE).
 *
 * Exported for {@link locale.test.ts}.
 * The CSV read path (quote handling, crlf, region fallback) has no other test.
 */
export async function readTuples(part: LocalePart, rng: () => number): Promise<LocaleBaseTuple[]> {
	// No `encoding` on the file path — CSVSpliterator delimits raw bytes and decodes utf-8 itself.
	// A string stream (from `{ encoding: "utf8" }`) would defeat its byte-range scanner.
	const input: NodeJS.ReadableStream | AsyncIterable<Uint8Array> = part.path
		? openReadStream(part.path)
		: readZipEntry(part.zip!, part.csv!)

	const get = (cells: string[], i: number): string => (i >= 0 && i < cells.length ? (cells[i] ?? "").trim() : "")
	const reservoir: LocaleBaseTuple[] = []
	let cols: ColumnIndex | null = null
	let header: string[] | null = null
	let seen = 0
	let dropped = 0

	try {
		// CSVSpliterator handles OA's quoted fields (embedded commas/newlines) and crlf row
		// terminators (spliterator ≥ 3.2.0); `header: false` yields the header row too,
		// so the column index is built from that first row rather than from a header option.
		for await (const cells of CSVSpliterator.fromAsync<string[]>(input, {
			header: false,
		})) {
			if (header === null) {
				header = cells.map((h) => h.trim().toLowerCase())
				// oxlint-disable-next-line no-loop-func -- the binding is per-iteration (for-of/for-await) and the batch is awaited before the next
				const ix = (name: string): number => header!.indexOf(name)

				// `cnigRaw` (ES pedanía only): the RAW cnig header has no
				// number/street/city/district/region/postcode at all —
				// `numero`/`nombre_via`/`poblacion`/`municipio`/`comunidad_autonoma`/`cod_postal` instead.
				// See {@link LocalePart.cnigRaw}.
				cols = part.cnigRaw
					? {
							num: ix("numero"),
							street: ix("nombre_via"),
							tipoVial: ix("tipo_vial"),
							city: ix("poblacion"),
							district: ix("municipio"),
							region: ix("comunidad_autonoma"),
							post: ix("cod_postal"),
						}
					: {
							num: ix("number"),
							street: ix("street"),
							tipoVial: -1,
							city: ix("city"),
							district: ix("district"),
							region: ix("region"),
							post: ix("postcode"),
						}

				continue
			}

			if (cols === null) continue

			// cnigRaw: street is split into a road-type column (`tipo_vial`, e.g. "carretera")
			// and the name (`nombre_via`) — rejoin them exactly as OA's own conform step does
			// (verified byte-identical to the conformed street column for the same source row).
			// Every other part's header already carries the pre-joined street column,
			// so `cols.tipoVial === -1` and this is a no-op there.
			const street =
				cols.tipoVial >= 0
					? [get(cells, cols.tipoVial), get(cells, cols.street)].filter(isPresent).join(" ")
					: get(cells, cols.street)

			const rawCity = get(cells, cols.city)

			if (!street) continue

			// Default: city → locality.
			// NZ/GB (`districtAsLocality`) inverts it.
			// The OA district holds the city (`Auckland`) and city holds the suburb (`Birkenhead`),
			// so district → locality and city → dependent_locality.
			// When district is empty (~18% of NZ rows), fall back to city → locality with no sub-locality.
			// GB PPD tuples flip which side is legitimately empty — on the majority of GB rows
			// city (the dependent_locality) is empty and district (the locality) is populated,
			// so the check below only drops a `districtAsLocality` row when both are empty, never
			// when city alone is — filtering on city alone silently discards most of the GB source.
			// See {@link LocalePart.districtAsLocality}.
			let locality: string | null
			let dependent_locality: string | undefined

			if (part.districtAsLocality) {
				const rawDistrict = get(cells, cols.district)

				if (!rawCity && !rawDistrict) continue

				const cleanedDistrict = cleanCityNoise(rawDistrict)

				if (cleanedDistrict) {
					locality = cleanedDistrict
					const cleanedCity = cleanCityNoise(rawCity)

					// ES pedanía lesson (2026-07-22): the cnig `poblacion` column is filled on ~93%
					// of rows but equals `municipio` on the majority of those (the address point
					// sits in the municipio's own main town rather than a below-municipio pedanía) —
					// only ~32.6% of ES rows carry a genuinely distinct poblacion.
					// GB/NZ never hit this (city/district name the same place only by rare coincidence),
					// but the guard is general: a dependent_locality equal to its own locality is
					// never a real sub-locality, so drop it rather than emit a same-value pair
					// (would fail the dep_loc≠locality invariant every recipe otherwise upholds).
					dependent_locality =
						cleanedCity && cleanedCity.localeCompare(locality, undefined, { sensitivity: "base" }) !== 0
							? cleanedCity
							: undefined
				} else {
					locality = cleanCityNoise(rawCity)
				}
			} else {
				if (!rawCity) continue
				locality = cleanCityNoise(rawCity)
			}

			if (!locality) {
				dropped++

				continue
			}

			const tuple: LocaleBaseTuple = {
				house_number: get(cells, cols.num),
				street,
				locality,
				region: get(cells, cols.region) || part.region || "",
				postcode: get(cells, cols.post),
				...(dependent_locality ? { dependent_locality } : {}),
			}

			seen++

			if (reservoir.length < RESERVOIR_CAP) {
				reservoir.push(tuple)
			} else {
				const j = Math.floor(rng() * seen)

				// 0 .. seen-1
				if (j < RESERVOIR_CAP) {
					reservoir[j] = tuple
				}
			}
		}
	} catch (error) {
		console.error(`  WARN: read failed for ${part.path ?? part.zip}: ${(error as Error).message}`)

		return []
	}

	console.error(`  ${part.path ?? part.csv}: ${reservoir.length} sampled of ${seen} rows (${dropped} city-noise drops)`)

	return reservoir
}

/**
 * Country-append fraction (the fr-admin-split #728 pattern, generalized to the locale recipe):
 * mutates `synth` in place, `countryFraction` of the time appending an explicit country
 * surface form ("United Kingdom") to `raw` + a `country` component.
 *
 * The model relearns to emit country when the token is present without over-firing
 * it on the (still-majority) country-less rows.
 *
 * `countryFraction <= 0` (the default) short-circuits the `random()` draw away entirely —
 * no `synth` mutation and no RNG consumption — so every existing locale's emit
 * stream stays byte-identical to before this option existed.
 * Exported for {@link locale.test.ts}.
 */
export function applyCountryAppend(
	synth: RenderedLocaleRow,
	country: string,
	countryFraction: number,
	random: () => number
): void {
	if (countryFraction > 0 && random() < countryFraction) {
		const forms = COUNTRY_SURFACE_FORMS[country as keyof typeof COUNTRY_SURFACE_FORMS]

		if (!forms?.length) {
			// The BR/NZ lesson: a missing table entry must never silently no-op a requested fraction.
			// It must raise so the gap is caught at build time rather than discovered
			// later as a 0% check failure.
			throw new Error(
				`No COUNTRY_SURFACE_FORMS entry for ${country} — add it to codex/country/country.ts before using --country-fraction`
			)
		}

		const form = sample(forms, random)
		synth.raw = `${synth.raw}, ${form}`
		synth.components = { ...synth.components, country: form }
	}
}

/**
 * Merge the `--district-as-locality` CLI override onto one part.
 *
 * `undefined` (flag absent) returns `part` unchanged (same object — no allocation, no behavior change);
 * `true`/`false` returns a shallow copy with `districtAsLocality` forced to
 * that value for this invocation only.
 * Exported for {@link locale.test.ts}.
 */
export function applyDistrictAsLocalityOverride(part: LocalePart, override: boolean | undefined): LocalePart {
	return override === undefined ? part : { ...part, districtAsLocality: override }
}

/**
 * Pick which part list a `--country` run reads: {@link LocaleCountrySource.pedaniaParts}
 * when the override is explicitly `true` and the country registers one (ES only, so far),
 * else the default `parts` — unchanged for every other country/override combination.
 *
 * Exported for {@link locale.test.ts}.
 */
export function resolveLocaleParts(countrySource: LocaleCountrySource, override: boolean | undefined): LocalePart[] {
	return override === true && countrySource.pedaniaParts ? countrySource.pedaniaParts : countrySource.parts
}

/**
 * Recipe registered with the corpus builder.
 *
 * See the file header for the parse behaviour it exists to exercise,
 * and `description` below for the surface form it generates.
 */
export const localeRecipe: CorpusRecipe = {
	name: "locale",
	description: "Per-locale coverage rows (DE/FR/NL/IT/ES/NZ/GB) from real OA tuples, both orders → renderLocaleRow",
	mode: "generate",
	options: [
		{ flag: "--country <cc>", description: "Target country (DE|FR|NL|IT|ES|NZ|GB). Default DE" },
		{ flag: "--intl-fraction <f>", description: "Fraction rendered international order. Default 0.4" },
		{
			flag: "--country-fraction <f>",
			description:
				"Fraction of rows that append an explicit country surface form (`, United Kingdom`) + a `country` component (fr-admin-split pattern). Default 0 — byte-identical to before when unset.",
		},
		{
			flag: "--district-as-locality / --no-district-as-locality",
			description:
				"Override the per-part districtAsLocality mapping for this run. Unset (default) leaves each COUNTRY_SOURCES part's own value untouched — every existing build stays byte-identical. ES additionally switches to the pedanía (poblacion→dependent_locality) source when passed as true — combine with --source-name synth-es-pedania.",
		},
	],
	async run(opts, write) {
		// Emit prng: the legacy build script seeded mulberry32(opts.seed).
		// The reservoir uses a separate per-part mulberry32 (below) so input sampling
		// never perturbs this emit stream.
		const random = makeMulberry32(opts.seed)
		const country = (opts.country ?? "DE").toUpperCase()
		const countrySource = COUNTRY_SOURCES[country]

		if (!countrySource) {
			throw new Error(
				`No OA sources registered for --country ${country}. Known: ${Object.keys(COUNTRY_SOURCES).join(", ")}.`
			)
		}

		const intlFraction = opts.intlFraction ?? 0.4

		if (!(intlFraction >= 0 && intlFraction <= 1)) {
			throw new Error(`--intl-fraction must be in [0, 1], got ${intlFraction}`)
		}

		// Default 0 → the `random() < countryFraction` draw below is short-circuited
		// away entirely (never consumed), so every existing locale's emit stream is
		// byte-identical to before this option existed.
		const countryFraction = opts.countryFraction ?? 0

		if (!(countryFraction >= 0 && countryFraction <= 1)) {
			throw new Error(`--country-fraction must be in [0, 1], got ${countryFraction}`)
		}

		const source = opts.sourceName ?? countrySource.source
		const count = opts.count ?? 4000
		// Tri-state: `undefined` (flag absent) touches nothing below.
		// `parts` stays the default list and each part keeps its own `districtAsLocality`,
		// so every existing locale build is byte-identical to before this option existed.
		// `true` additionally selects `pedaniaParts` when the country registers one (ES); `false`
		// forces the mapping off on every part read this run (a debugging override for GB/NZ).
		const districtAsLocalityOverride = opts.districtAsLocality
		const parts = resolveLocaleParts(countrySource, districtAsLocalityOverride)

		const pool: LocaleBaseTuple[] = []

		for (let pi = 0; pi < parts.length; pi++) {
			// A reservoir prng per part, seeded but independent of the emit loop's `random`,
			// so the sample is reproducible without perturbing the synth/order draws.
			const reservoirRng = makeMulberry32((opts.seed ^ (0x9e_37_79_b9 * (pi + 1))) >>> 0)
			const effectivePart = applyDistrictAsLocalityOverride(parts[pi]!, districtAsLocalityOverride)
			const t = await readTuples(effectivePart, reservoirRng)

			for (const x of t) {
				pool.push(x)
			} // Not pool.push(...t) — spreading huge arrays overflows the stack
		}

		if (!pool.length) {
			throw new Error(`No ${country} tuples found — are the source CSVs/zips present? (see COUNTRY_SOURCES)`)
		}

		let emitted = 0
		let skipped = 0
		let guard = 0
		const N = pool.length

		while (emitted < count && guard++ < count * 6) {
			const base = pool[Math.floor(random() * N)]!
			const order = random() < intlFraction ? "international" : "native"

			// Per-country surface-shape draws (#241) — consumed only for that country,
			// so the DE/FR emit streams for a given seed are unchanged by their existence.
			const nativeHouseJoin =
				country === "ES" ? (random() < ES_SPACE_JOIN_FRACTION ? ("space" as const) : ("template" as const)) : undefined

			const postcodeShape =
				country === "NL"
					? random() < NL_GLUED_POSTCODE_FRACTION
						? ("as-source" as const)
						: ("conventional" as const)
					: undefined

			const synth = renderLocaleRow(base, country, { random, order, nativeHouseJoin, postcodeShape })

			if (!synth) {
				skipped++

				continue
			}

			applyCountryAppend(synth, country, countryFraction, random)

			if (opts.golden) {
				// Golden rows must round-trip through alignRow exactly like training rows (#241 done-when):
				// a render that can't be BIO-labeled can't serve as a parser golden either.
				// Consumes no RNG draw.
				const goldenCanonical = {
					raw: synth.raw,
					components: synth.components,
					country,
					locale: synth.locale,
					source,
					source_id: "golden:align-check",
				}

				const goldenAligned = alignRow(goldenCanonical as Parameters<typeof alignRow>[0])

				if (goldenAligned.kind !== "labeled" || !goldenAligned.row) {
					skipped++

					continue
				}

				write(stringifyJSON({ raw: synth.raw, components: synth.components, country, order }))

				emitted++

				continue
			}

			const sourceID = stableSourceID(source, {
				street: synth.components.street,
				house_number: synth.components.house_number,
				locality: synth.components.locality,
				postcode: synth.components.postcode,
			})

			const canonical = {
				raw: synth.raw,
				components: synth.components,
				country,
				locale: synth.locale,
				source,
				source_id: sourceID,
				corpus_version: countrySource.corpusVersion,
				license: `OpenAddresses ${country} tuples, rendered ${order}-order — see ingest SOURCES`,
			}

			const aligned = alignRow(canonical as Parameters<typeof alignRow>[0])

			if (aligned.kind !== "labeled" || !aligned.row) {
				skipped++

				continue
			}

			write(stringifyJSON({ ...aligned.row, synth_method: source, synth_order: order, synth_base_id: null }))

			emitted++
		}

		return { emitted, skipped }
	},
}
