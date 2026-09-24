/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Sample real locale address tuples with bounded memory, render native and international forms,
 *   align components, and emit labeled rows. Sampling and rendering use separate seeded generators.
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
import { SourceRegister } from "#registers"
import { type LocaleBaseTuple, type RenderedLocaleRow, renderLocaleRow } from "#surfaces/locale"
import { SurfaceOrigin } from "#types"
import { alignRow } from "#utils"

/**
 * OpenAddresses source part, read from a ZIP member or extracted CSV.
 */
export interface LocalePart {
	zip?: PathBuilderLike
	csv?: string
	path?: PathBuilderLike
	region?: string
	/**
	 * Map district to locality and city to dependent locality; fall back to city when district is empty.
	 */
	districtAsLocality?: boolean
	/**
	 * Read Spain's raw CNIG schema: `poblacion` is the settlement, `municipio` its parent,
	 * and street combines `tipo_vial` with `nombre_via`.
	 */
	cnigRaw?: boolean
}

export interface LocaleCountrySource {
	source: string
	parts: LocalePart[]
	/**
	 * Publication register stamped on rows.
	 * GB uses `synth-gb` for HM Land Registry Price Paid Data.
	 */
	register: SourceRegister
	/**
	 * Corpus version stamped on emitted rows.
	 */
	corpusVersion: string
	/**
	 * Alternate source parts selected when the district-as-locality override is enabled.
	 */
	pedaniaParts?: LocalePart[]
}

/**
 * Source files and metadata for each supported country.
 */
const COUNTRY_SOURCES: Record<string, LocaleCountrySource> = {
	DE: {
		source: "synth-german",
		register: SourceRegister.OpenAddresses,
		corpusVersion: "0.4.0",
		parts: [
			{ zip: dataRootPath("oa-cache", "de__berlin.zip"), csv: "de/berlin.csv", region: "Berlin" },
			{ zip: dataRootPath("oa-cache", "de__sn__statewide.zip"), csv: "de/sn/statewide.csv", region: "Sachsen" },
		],
	},
	FR: {
		source: "synth-fr",
		register: SourceRegister.OpenAddresses,
		corpusVersion: "0.4.0",
		parts: [{ zip: dataRootPath("oa-cache", "fr__countrywide.zip"), csv: "fr/countrywide.csv" }],
	},
	NL: {
		source: "synth-nl",
		register: SourceRegister.OpenAddresses,
		corpusVersion: "0.9.9",
		parts: [{ path: dataRootPath("openaddresses", "extracted", "nl", "countrywide.csv") }],
	},
	IT: {
		source: "synth-it",
		register: SourceRegister.OpenAddresses,
		corpusVersion: "0.9.9",
		parts: [{ zip: dataRootPath("oa-cache", "it__countrywide.zip"), csv: "it/countrywide.csv" }],
	},
	// These countries use the standard OA schema.
	// Saudi Arabia has no shipped Arabic model; Iceland has too few localities;
	// Estonia's locality field needs municipality and village mapped to separate tags.
	PT: {
		source: "synth-pt",
		register: SourceRegister.OpenAddresses,
		corpusVersion: "0.9.9",
		parts: [{ path: dataRootPath("openaddresses", "extracted", "pt", "countrywide.csv") }],
	},
	CH: {
		source: "synth-ch",
		register: SourceRegister.OpenAddresses,
		corpusVersion: "0.9.9",
		parts: [{ path: dataRootPath("openaddresses", "extracted", "ch", "countrywide.csv") }],
	},
	HR: {
		source: "synth-hr",
		register: SourceRegister.OpenAddresses,
		corpusVersion: "0.9.9",
		parts: [{ path: dataRootPath("openaddresses", "extracted", "hr", "countrywide.csv") }],
	},
	SK: {
		source: "synth-sk",
		register: SourceRegister.OpenAddresses,
		corpusVersion: "0.9.9",
		parts: [{ path: dataRootPath("openaddresses", "extracted", "sk", "countrywide.csv") }],
	},
	LU: {
		source: "synth-lu",
		register: SourceRegister.OpenAddresses,
		corpusVersion: "0.9.9",
		parts: [{ path: dataRootPath("openaddresses", "extracted", "lu", "countrywide.csv") }],
	},
	ES: {
		source: "synth-es",
		register: SourceRegister.OpenAddresses,
		corpusVersion: "0.9.9",
		parts: [{ path: dataRootPath("openaddresses", "extracted", "es", "countrywide.csv") }],
		// Raw CNIG data retains pedanía names absent from the conformed OA file.
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
		// NZ stores city in district and suburb in city; no postcode is supplied.
		source: "synth-nz",
		register: SourceRegister.OpenAddresses,
		corpusVersion: "0.9.9",
		// Read the full source; evaluation holdouts are generated separately.
		parts: [{ path: dataRootPath("openaddresses", "extracted", "nz", "countrywide.csv"), districtAsLocality: true }],
	},
	GB: {
		// PPD stores postal town in district and optional dependent locality in city.
		source: "synth-gb",
		register: SourceRegister.LandRegistryPricePaid,
		corpusVersion: "0.9.9",
		parts: [{ path: dataRootPath("ppd", "2026-07-22", "gb-tuples.csv"), districtAsLocality: true }],
	},
}

/**
 * Per-part sample cap; reservoir sampling bounds memory use.
 */
const RESERVOIR_CAP = 1_200_000

/**
 * Fraction of native ES rows joining street and number with a space.
 */
const ES_SPACE_JOIN_FRACTION = 0.5

/**
 * Fraction of NL rows retaining the source postcode without a space.
 */
const NL_GLUED_POSTCODE_FRACTION = 0.5

/**
 * Remove pseudo-localities, comma-joined aggregates, and trailing parenthesized
 * admin codes while preserving valid names.
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
	 * CNIG-only road-type column; `-1` for other sources.
	 */
	tipoVial: number
}

/**
 * Stream tuples from a ZIP member or CSV and reservoir-sample them with Algorithm R. The
 * supplied RNG makes sampling reproducible; OA rows need no global deduplication.
 */
export async function readTuples(part: LocalePart, rng: () => number): Promise<LocaleBaseTuple[]> {
	// Keep the file stream as bytes; CSVSpliterator handles UTF-8 decoding.
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
		// Parse quoted fields and CRLF rows.
		// With `header: false`, the first row supplies column names.
		for await (const cells of CSVSpliterator.fromAsync<string[]>(input, {
			header: false,
		})) {
			if (header === null) {
				header = cells.map((h) => h.trim().toLowerCase())
				// oxlint-disable-next-line no-loop-func -- the binding is per-iteration (for-of/for-await) and the batch is awaited before the next
				const ix = (name: string): number => header!.indexOf(name)

				// Raw CNIG uses Spanish column names rather than the standard OA schema.
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

			// Raw CNIG separates road type and name; other OA sources provide a joined street value.
			const street =
				cols.tipoVial >= 0
					? [get(cells, cols.tipoVial), get(cells, cols.street)].filter(isPresent).join(" ")
					: get(cells, cols.street)

			const rawCity = get(cells, cols.city)

			if (!street) continue

			// NZ and GB use district as locality and city as dependent locality.
			// Fall back to city when district is empty; GB may omit city entirely.
			let locality: string | null
			let dependent_locality: string | undefined

			if (part.districtAsLocality) {
				const rawDistrict = get(cells, cols.district)

				if (!rawCity && !rawDistrict) continue

				const cleanedDistrict = cleanCityNoise(rawDistrict)

				if (cleanedDistrict) {
					locality = cleanedDistrict
					const cleanedCity = cleanCityNoise(rawCity)

					// CNIG often repeats municipio in poblacion; omit a dependent locality that duplicates its locality.
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

				// Choose an index from all rows seen so far.
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
 * Append a country surface form and component at the requested fraction.
 *
 * A zero fraction makes no mutation and consumes no RNG, preserving existing seeded output.
 * Exported for tests.
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
			// Fail immediately if a requested country form has no codex entry.
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
 * Apply the per-run district mapping override, preserving the original object when unset.
 * Exported for tests.
 */
export function applyDistrictAsLocalityOverride(part: LocalePart, override: boolean | undefined): LocalePart {
	return override === undefined ? part : { ...part, districtAsLocality: override }
}

/**
 * Select alternate parts only when the override is true and the country defines them.
 * Exported for tests.
 */
export function resolveLocaleParts(countrySource: LocaleCountrySource, override: boolean | undefined): LocalePart[] {
	return override === true && countrySource.pedaniaParts ? countrySource.pedaniaParts : countrySource.parts
}

/**
 * Locale recipe registered with the corpus builder.
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
		// Keep output generation independent from per-part sampling.
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

		// A zero default consumes no random draw, preserving existing output.
		const countryFraction = opts.countryFraction ?? 0

		if (!(countryFraction >= 0 && countryFraction <= 1)) {
			throw new Error(`--country-fraction must be in [0, 1], got ${countryFraction}`)
		}

		const source = opts.sourceName ?? countrySource.source
		const count = opts.count ?? 4000
		// Unset preserves each part's configuration; true may select ES pedanía data, and false disables the mapping.
		const districtAsLocalityOverride = opts.districtAsLocality
		const parts = resolveLocaleParts(countrySource, districtAsLocalityOverride)

		const pool: LocaleBaseTuple[] = []

		for (let pi = 0; pi < parts.length; pi++) {
			// Seed each part's sampler independently from the output RNG.
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

			// Consume format draws only for the relevant country, preserving other seeded output streams.
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
				// Require golden rows to align like training rows; this check consumes no RNG.
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

			// Components come from the source; this recipe composes their order, punctuation, and casing.
			write(
				stringifyJSON({
					...aligned.row,
					recipe: source,
					order,
					base_source_id: null,
					register: countrySource.register,
					surface: SurfaceOrigin.Composed,
				})
			)

			emitted++
		}

		return { emitted, skipped }
	},
}
