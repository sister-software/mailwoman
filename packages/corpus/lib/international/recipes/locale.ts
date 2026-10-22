/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Samples real address tuples for one country and renders them in the country's native order.
 *   It emits aligned rows. The recipe samples and renders with separate seeded generators. The postcode on the far
 *   side of the locality is the training-time `postcode_move` augmentation's job (#2750).
 */

import { COUNTRY_SURFACE_FORMS } from "@mailwoman/codex/country"
import { dataRootPath } from "@mailwoman/core/data-root"
import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { openReadStream } from "@mailwoman/core/fs/streams"
import { readZipEntry } from "@mailwoman/core/fs/zip"
import { stringifyJSON } from "@mailwoman/core/json"
import { isPresent } from "@mailwoman/core/objects"
import { sample } from "@mailwoman/core/random"
import { mulberry32 as makeMulberry32 } from "@mailwoman/core/utils"
import type { PathBuilderLike } from "path-ts"
import { CSVSpliterator, JSONSpliterator } from "spliterator"

import { RenderedRowIDs } from "#adapters/record-id"
import { stableSourceID } from "#adapters/source-id"
import { GB_OS_OPEN_ADAPTER_ID, gbOSOpenCanonicalRowsPath } from "#gb/adapters/os-open/adapter"
import { openConstituentCountryReader } from "#gb/constituent-country"
import { readCountyOfPostcode } from "#gb/county"
import type { CorpusRecipe } from "#recipes/scaffold"
import { defaultRecipeSource } from "#recipes/sources"
import { SourceRegister } from "#registers"
import { type LocaleBaseTuple, type RenderedLocaleRow, regionDrawRandom, renderLocaleRow } from "#surfaces/locale"
import { SurfaceOrigin } from "#types"
import { alignRow } from "#utils"

/**
 * One source file: a CSV member of a ZIP (`zip` and `csv`), an extracted CSV (`path`),
 * or an adapter's canonical rows (`canonicalRows`).
 */
export interface LocalePart {
	zip?: PathBuilderLike
	csv?: string
	path?: PathBuilderLike
	/**
	 * An adapter's `canonical.jsonl`, read in place of a CSV.
	 *
	 * Each row's `components` supplies the house number, street, locality and postcode.
	 * Every row must carry {@linkcode LocalePart.canonicalSource} as its `source`.
	 */
	canonicalRows?: PathBuilderLike
	/**
	 * The `source` every row of {@linkcode LocalePart.canonicalRows} must carry.
	 *
	 * A row from any other source throws, so a file another adapter wrote is never read as this one.
	 */
	canonicalSource?: string
	region?: string
	/**
	 * Maps the district column to locality and the city column to dependent locality.
	 * When the district is empty, the city becomes the locality.
	 */
	districtAsLocality?: boolean
	/**
	 * Reads Spain's raw CNIG schema.
	 *
	 * `poblacion` is the settlement.
	 * `municipio` is its parent.
	 * The street combines `tipo_vial` with `nombre_via`.
	 */
	cnigRaw?: boolean
	/**
	 * Opens a reader that answers the row's region from its postcode, replacing the region column.
	 *
	 * A GB part answers the county or the constituent country this way.
	 */
	regionOfPostcode?: () => Promise<(postcode: string) => string | null>
}

/**
 * The share of GB postcodes whose rows label the county `region`, out of five.
 *
 * The other postcodes' rows label the constituent country, which Who's On First
 * records as a `macroregion` under the United Kingdom.
 */
const GB_COUNTY_REGION_FIFTHS = 4

/**
 * Whether a GB postcode's rows label the county rather than the constituent country.
 *
 * The choice is a function of the postcode alone, so a rebuild makes the same choice for every row.
 */
function gbPostcodeTakesCounty(postcode: string): boolean {
	let sum = 0

	for (const char of postcode) {
		sum += char.codePointAt(0)!
	}

	return sum % 5 < GB_COUNTY_REGION_FIFTHS
}

/**
 * The source files and row metadata for one country.
 */
export interface LocaleCountrySource {
	source: string
	parts: LocalePart[]
	/**
	 * The publication register written to each row.
	 */
	register: SourceRegister
	/**
	 * The share of rows that write the tuple's region, drawn from {@linkcode regionDrawRandom}.
	 *
	 * @defaultValue 0: no row prints a region.
	 */
	regionFraction?: number
	/**
	 * The dataset and terms the row's `license` names, before the rendering order.
	 *
	 * @defaultValue `OpenAddresses <CC> tuples`
	 */
	license?: string
	/**
	 * Replacement parts used when `--district-as-locality` is passed as true.
	 */
	pedaniaParts?: LocalePart[]
}

/**
 * The source files and metadata for each supported country.
 */
const COUNTRY_SOURCES: Record<string, LocaleCountrySource> = {
	DE: {
		source: defaultRecipeSource("synth-german"),
		register: SourceRegister.OpenAddresses,
		parts: [
			{ zip: dataRootPath("oa-cache", "de__berlin.zip"), csv: "de/berlin.csv", region: "Berlin" },
			{ zip: dataRootPath("oa-cache", "de__sn__statewide.zip"), csv: "de/sn/statewide.csv", region: "Sachsen" },
		],
	},
	FR: {
		source: defaultRecipeSource("synth-fr"),
		register: SourceRegister.OpenAddresses,
		parts: [{ zip: dataRootPath("oa-cache", "fr__countrywide.zip"), csv: "fr/countrywide.csv" }],
	},
	NL: {
		source: defaultRecipeSource("synth-nl"),
		register: SourceRegister.OpenAddresses,
		parts: [{ path: dataRootPath("openaddresses", "extracted", "nl", "countrywide.csv") }],
	},
	IT: {
		source: defaultRecipeSource("synth-it"),
		register: SourceRegister.OpenAddresses,
		parts: [{ zip: dataRootPath("oa-cache", "it__countrywide.zip"), csv: "it/countrywide.csv" }],
	},
	PT: {
		source: defaultRecipeSource("synth-pt"),
		register: SourceRegister.OpenAddresses,
		parts: [{ path: dataRootPath("openaddresses", "extracted", "pt", "countrywide.csv") }],
	},
	CH: {
		source: defaultRecipeSource("synth-ch"),
		register: SourceRegister.OpenAddresses,
		parts: [{ path: dataRootPath("openaddresses", "extracted", "ch", "countrywide.csv") }],
	},
	HR: {
		source: defaultRecipeSource("synth-hr"),
		register: SourceRegister.OpenAddresses,
		parts: [{ path: dataRootPath("openaddresses", "extracted", "hr", "countrywide.csv") }],
	},
	SK: {
		source: defaultRecipeSource("synth-sk"),
		register: SourceRegister.OpenAddresses,
		parts: [{ path: dataRootPath("openaddresses", "extracted", "sk", "countrywide.csv") }],
	},
	LU: {
		source: defaultRecipeSource("synth-lu"),
		register: SourceRegister.OpenAddresses,
		parts: [{ path: dataRootPath("openaddresses", "extracted", "lu", "countrywide.csv") }],
	},
	ES: {
		source: defaultRecipeSource("synth-es"),
		register: SourceRegister.OpenAddresses,
		parts: [{ path: dataRootPath("openaddresses", "extracted", "es", "countrywide.csv") }],
		// The raw CNIG file keeps pedanía names that the conformed OA file drops.
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
		// NZ stores the city in `district` and the suburb in `city`.
		// The source has no postcodes.
		source: defaultRecipeSource("synth-nz"),
		register: SourceRegister.OpenAddresses,
		parts: [{ path: dataRootPath("openaddresses", "extracted", "nz", "countrywide.csv"), districtAsLocality: true }],
	},
	GB: {
		// The `gb-os-open` adapter's rows: Code-Point Open postcodes joined to OS Open Roads and OS Open Names.
		// `rendered-gb` read HM Land Registry Price Paid Data, whose address fields
		// Royal Mail and Ordnance Survey license for non-commercial use only (#2635),
		// so GB rows carry a source name of their own.
		source: defaultRecipeSource("synth-gb-os-open"),
		register: SourceRegister.OrdnanceSurveyOpenData,
		license: "OS OpenData GB tuples (OGL-UK-3.0)",
		// The share of rows #2676 shipped in v0.7.10: 52,103 of 786,626 train rows (6.6%) labeled the county
		// or constituent country. The run skips a row whose text it already wrote (#2765), and a row with a
		// region rarely repeats, so 5.7% of draws yields 6.6% of written rows.
		regionFraction: 0.057,
		// The adapter's rows carry no region.
		// The county comes from OS Open Names and the constituent country from NSUL, both by postcode.
		parts: [
			{
				canonicalRows: gbOSOpenCanonicalRowsPath(),
				canonicalSource: GB_OS_OPEN_ADAPTER_ID,
				regionOfPostcode: async () => {
					const countryOf = openConstituentCountryReader()
					const countyOf = await readCountyOfPostcode()

					return (postcode) => (gbPostcodeTakesCounty(postcode) && countyOf.get(postcode)) || countryOf(postcode).name
				},
			},
		],
	},
}

/**
 * The reservoir size per part.
 * This value bounds memory use.
 */
const RESERVOIR_CAP = 1_200_000

/**
 * The share of ES rows that join street and house number with a space instead of the template separator.
 */
const ES_SPACE_JOIN_FRACTION = 0.5

/**
 * The share of NL rows that keep the source postcode form without a space.
 */
const NL_GLUED_POSTCODE_FRACTION = 0.5

/**
 * Cleans a city value.
 *
 * Returns `null` for a value with a comma or four digits.
 * Strips a trailing parenthesized code of one to three letters.
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
	 * The CNIG road-type column.
	 * It is `-1` for other sources.
	 */
	tipoVial: number
}

/**
 * One row of an adapter's `canonical.jsonl`, as far as the locale recipe reads it.
 */
interface CanonicalTupleRow {
	source?: unknown
	components?: Partial<Record<"house_number" | "street" | "locality" | "postcode", unknown>>
}

/**
 * Reservoir-samples an adapter's canonical rows with Algorithm R, using `rng` for reproducibility.
 *
 * A row without a street or locality is skipped.
 * A missing file throws rather than reading as an empty part.
 *
 * @throws When a row's `source` differs from `part.canonicalSource`.
 */
async function readCanonicalTuples(
	part: LocalePart,
	rows: PathBuilderLike,
	rng: () => number
): Promise<LocaleBaseTuple[]> {
	if (!(await pathExists(rows))) {
		throw new Error(
			`${rows.toString()} is absent. Write it with \`mailwoman corpus run ${part.canonicalSource ?? "<adapter>"}\`.`
		)
	}

	const reservoir: LocaleBaseTuple[] = []
	const regionOf = await part.regionOfPostcode?.()
	let seen = 0
	let regionUnknown = 0

	for await (const row of JSONSpliterator.fromAsync<CanonicalTupleRow>(rows)) {
		if (part.canonicalSource && row.source !== part.canonicalSource) {
			throw new Error(
				`${rows.toString()} holds a row from source ${stringifyJSON(row.source)}; this part reads ${part.canonicalSource} rows only.`
			)
		}

		const components = row.components ?? {}
		const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "")
		const street = text(components.street)
		const locality = text(components.locality)

		if (!street || !locality) continue

		const postcode = text(components.postcode)
		let region = part.region ?? ""

		if (regionOf) {
			region = (postcode && regionOf(postcode)) || ""

			if (!region) {
				regionUnknown++
			}
		}

		const tuple: LocaleBaseTuple = {
			house_number: text(components.house_number),
			street,
			locality,
			region,
			postcode,
		}

		seen++

		if (reservoir.length < RESERVOIR_CAP) {
			reservoir.push(tuple)
		} else {
			const j = Math.floor(rng() * seen)

			if (j < RESERVOIR_CAP) {
				reservoir[j] = tuple
			}
		}
	}

	console.error(`  ${rows.toString()}: ${reservoir.length} sampled of ${seen} rows`)

	if (regionOf) {
		console.error(`  ${rows.toString()}: ${regionUnknown} rows have no region for their postcode`)
	}

	return reservoir
}

/**
 * Streams tuples from one part and reservoir-samples them with Algorithm R,
 * using `rng` for reproducibility.
 *
 * @throws When the part cannot be read, naming the file.
 */
export async function readTuples(part: LocalePart, rng: () => number): Promise<LocaleBaseTuple[]> {
	if (part.canonicalRows) return readCanonicalTuples(part, part.canonicalRows, rng)

	// The stream stays as bytes because CSVSpliterator decodes UTF-8 itself.
	const input: NodeJS.ReadableStream | AsyncIterable<Uint8Array> = part.path
		? openReadStream(part.path)
		: readZipEntry(part.zip!, part.csv!)

	const get = (cells: string[], i: number): string => (i >= 0 && i < cells.length ? (cells[i] ?? "") : "")
	const reservoir: LocaleBaseTuple[] = []
	let cols: ColumnIndex | null = null
	let header: string[] | null = null
	let seen = 0
	let dropped = 0
	const regionOf = await part.regionOfPostcode?.()
	let regionUnknown = 0

	try {
		// The first row holds the column names.
		for await (const cells of CSVSpliterator.fromAsync<string[]>(input, {
			header: false,
		})) {
			if (!header) {
				header = cells.map((h) => h.toLowerCase())
				// oxlint-disable-next-line no-loop-func -- the binding is per-iteration (for-of/for-await) and the batch is awaited before the next
				const ix = (name: string): number => header!.indexOf(name)

				// Raw CNIG files use Spanish column names.
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

			if (!cols) continue

			// Raw CNIG splits the road type from the street name, so the two are joined here.
			const street =
				cols.tipoVial >= 0
					? [get(cells, cols.tipoVial), get(cells, cols.street)].filter(isPresent).join(" ")
					: get(cells, cols.street)

			const rawCity = get(cells, cols.city)

			if (!street) continue

			let locality: string | null
			let dependent_locality: string | null = null

			if (part.districtAsLocality) {
				const rawDistrict = get(cells, cols.district)

				if (!rawCity && !rawDistrict) continue

				const cleanedDistrict = cleanCityNoise(rawDistrict)

				if (cleanedDistrict) {
					locality = cleanedDistrict
					const cleanedCity = cleanCityNoise(rawCity)

					// A city equal to the locality, as when CNIG repeats `municipio` in `poblacion`, is dropped.
					dependent_locality =
						cleanedCity && cleanedCity.localeCompare(locality, undefined, { sensitivity: "base" }) !== 0
							? cleanedCity
							: null
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

			const postcode = get(cells, cols.post)

			let region = get(cells, cols.region) || part.region || ""

			if (regionOf) {
				region = (postcode && regionOf(postcode)) || ""

				if (!region) {
					regionUnknown++
				}
			}

			const tuple: LocaleBaseTuple = {
				house_number: get(cells, cols.num),
				street,
				locality,
				region,
				postcode,
				...(dependent_locality ? { dependent_locality } : {}),
			}

			seen++

			if (reservoir.length < RESERVOIR_CAP) {
				reservoir.push(tuple)
			} else {
				const j = Math.floor(rng() * seen)

				if (j < RESERVOIR_CAP) {
					reservoir[j] = tuple
				}
			}
		}
	} catch (error) {
		// An unreadable part throws rather than reading as an empty one.
		// The sub-venue recipe's DE leg once emitted zero rows behind a warning
		// when `europe.zip` left the data root.
		throw new Error(`${(part.path ?? part.zip)?.toString()} could not be read: ${(error as Error).message}`, {
			cause: error,
		})
	}

	console.error(`  ${part.path ?? part.csv}: ${reservoir.length} sampled of ${seen} rows (${dropped} city-noise drops)`)

	if (regionOf) {
		console.error(`  ${part.path ?? part.csv}: ${regionUnknown} rows have no region for their postcode`)
	}

	return reservoir
}

/**
 * Appends a country name to the row's text and components with probability `countryFraction`.
 *
 * A zero fraction draws no random number, so seeded output stays the same as a run without the option.
 *
 * @throws When the codex has no surface forms for the country.
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
 * Applies the per-run `districtAsLocality` override to a part.
 * An unset override returns the part unchanged.
 */
export function applyDistrictAsLocalityOverride(part: LocalePart, override: boolean | null): LocalePart {
	return override === null ? part : { ...part, districtAsLocality: override }
}

/**
 * Returns the country's `pedaniaParts` when the override is true and that property exists.
 * Returns the default parts in all other cases.
 */
export function resolveLocaleParts(countrySource: LocaleCountrySource, override: boolean | null): LocalePart[] {
	return override === true && countrySource.pedaniaParts ? countrySource.pedaniaParts : countrySource.parts
}

/**
 * The locale recipe registered with the corpus builder.
 */
export const localeRecipe: CorpusRecipe = {
	name: "locale",
	description:
		"Per-locale coverage rows (DE/FR/NL/IT/ES/NZ/GB) from real OA tuples (OS OpenData for GB), native order → renderLocaleRow",
	mode: "generate",
	options: [
		{ flag: "--country <cc>", description: "Target country (DE|FR|NL|IT|ES|NZ|GB). Default DE" },
		{
			flag: "--region-fraction <f>",
			description: "Fraction of rows that write the tuple's region. Default: the country's share (GB 0.057, else 0)",
		},
		{
			flag: "--country-fraction <f>",
			description:
				"Fraction of rows that append an explicit country surface form (`, United Kingdom`) + a `country` component (fr-admin-split pattern). Default 0 — byte-identical to before when unset.",
		},
		{
			flag: "--district-as-locality / --no-district-as-locality",
			description:
				"Override the per-part districtAsLocality mapping for this run. Unset (default) leaves each COUNTRY_SOURCES part's own value untouched — every existing build stays byte-identical. ES additionally switches to the pedanía (poblacion→dependent_locality) source when passed as true — combine with --source-name rendered-es-pedania.",
		},
	],
	async run(opts, write) {
		// Each part's sampler gets its own generator below, so this one drives rendering only.
		const random = makeMulberry32(opts.seed)
		const regionRandom = regionDrawRandom(opts.seed)
		const country = (opts.country ?? "DE").toUpperCase()
		const countrySource = COUNTRY_SOURCES[country]

		if (!countrySource) {
			throw new Error(
				`No OA sources registered for --country ${country}. Known: ${Object.keys(COUNTRY_SOURCES).join(", ")}.`
			)
		}

		const countryFraction = opts.countryFraction ?? 0
		const regionFraction = opts.regionFraction ?? countrySource.regionFraction ?? 0

		if (!(regionFraction >= 0 && regionFraction <= 1)) {
			throw new Error(`--region-fraction must be in [0, 1], got ${regionFraction}`)
		}

		if (!(countryFraction >= 0 && countryFraction <= 1)) {
			throw new Error(`--country-fraction must be in [0, 1], got ${countryFraction}`)
		}

		// Each `COUNTRY_SOURCES` entry already holds the current spelling from `defaultRecipeSource`.
		const source = opts.sourceName ?? countrySource.source
		const count = opts.count ?? 4000
		// When unset, each part keeps its own setting.
		// True also selects the ES pedanía parts.
		const districtAsLocalityOverride = opts.districtAsLocality ?? null
		const parts = resolveLocaleParts(countrySource, districtAsLocalityOverride)

		const pool: LocaleBaseTuple[] = []

		for (let pi = 0; pi < parts.length; pi++) {
			// The seed is derived from the run seed and part index.
			const reservoirRng = makeMulberry32((opts.seed ^ (0x9e_37_79_b9 * (pi + 1))) >>> 0)
			const effectivePart = applyDistrictAsLocalityOverride(parts[pi]!, districtAsLocalityOverride)
			const t = await readTuples(effectivePart, reservoirRng)

			// A spread of an array this large into `push` would overflow the stack.
			for (const x of t) {
				pool.push(x)
			}
		}

		if (!pool.length) {
			throw new Error(`No ${country} tuples found — are the source CSVs/zips present? (see COUNTRY_SOURCES)`)
		}

		let emitted = 0
		let skipped = 0
		let guard = 0
		const N = pool.length
		const rowIDs = new RenderedRowIDs()

		while (emitted < count && guard++ < count * 6) {
			const base = pool[Math.floor(random() * N)]!
			const order = "native"

			// These draws happen only for ES and NL, so other countries' seeded output
			// is unaffected. country-branch: the ES house-number join and the NL glued
			// postcode are measured surface shares for those two sources.
			// A per-country surface table in the codex address layouts would replace both branches.
			const nativeHouseJoin =
				country === "ES" ? (random() < ES_SPACE_JOIN_FRACTION ? ("space" as const) : ("template" as const)) : undefined

			// country-branch: see the ES branch above.
			const postcodeShape =
				country === "NL"
					? random() < NL_GLUED_POSTCODE_FRACTION
						? ("as-source" as const)
						: ("conventional" as const)
					: undefined

			const withRegion = regionFraction > 0 && regionRandom() < regionFraction
			const synth = renderLocaleRow(base, country, { random, nativeHouseJoin, postcodeShape, withRegion })

			if (!synth) {
				skipped++

				continue
			}

			applyCountryAppend(synth, country, countryFraction, random)

			if (opts.golden) {
				// Golden rows must pass the same alignment check as training rows.
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

			// The record is the tuple, and the text tells its renderings apart (#2765).
			const sourceID = rowIDs.claim(
				stableSourceID(source, {
					street: synth.components.street,
					house_number: synth.components.house_number,
					locality: synth.components.locality,
					postcode: synth.components.postcode,
				}),
				synth.raw
			)

			if (!sourceID) {
				skipped++

				continue
			}

			const canonical = {
				raw: synth.raw,
				components: synth.components,
				country,
				locale: synth.locale,
				source,
				source_id: sourceID,
				license: `${countrySource.license ?? `OpenAddresses ${country} tuples`}, rendered ${order}-order — see ingest SOURCES`,
			}

			const aligned = alignRow(canonical as Parameters<typeof alignRow>[0])

			if (aligned.kind !== "labeled" || !aligned.row) {
				skipped++

				continue
			}

			// The component values are real.
			// The recipe composes their order, punctuation and casing.
			write(
				stringifyJSON({
					...aligned.row,
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
