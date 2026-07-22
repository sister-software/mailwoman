/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `locale` shard recipe — the multi-locale generalization of the `german` recipe. Reads REAL
 *   OpenAddresses tuples for a `--country` (DE/FR/NL/IT/ES), renders each via
 *   {@link synthesizeLocaleRow} in BOTH orders (`--intl-fraction`, default 0.4 international / the
 *   rest country-native), aligns to BIO, and emits a labeled JSONL. Generate-mode: it STREAMS each
 *   source CSV (`unzip -p` for cached zips, plain `createReadStream` for extracted CSVs) and
 *   reservoir-samples to {@link RESERVOIR_CAP} (so FR/ES countrywide work in bounded memory), then
 *   draws `--count` rows from the pool with the passed `random`. Ported from
 *   scripts/build-locale-shard.mjs.
 *
 *   The reservoir uses its OWN seeded PRNG ({@link makeMulberry32}, per part), independent of the
 *   emit `random`, so the input sample is reproducible WITHOUT perturbing the synth/order draws.
 *
 *   SURFACE DIVERSITY (#241): two per-country shape draws ride the emit loop, sized by the
 *   2026-07-02 format-diversity audit against the `openaddresses-{es,nl,it}-sample.jsonl` observed
 *   forms. ES: the OpenCage template comma-joins the house number (`CALLE MAYOR, 12`) but all 3,000
 *   eval rows space-join (`CALLE MAYOR 12`) — {@link ES_SPACE_JOIN_FRACTION} of native rows collapse
 *   the comma. NL: OA (and the eval, 3,000/3,000) glue the postcode (`1187LM`) while the national
 *   convention spaces it (`1187 LM`) — {@link NL_GLUED_POSTCODE_FRACTION} of rows keep the glued
 *   source shape, the rest the spaced conventional one. These draws are consumed ONLY for their
 *   country, so DE/FR emit streams are unchanged for a given seed.
 */

import { spawn } from "node:child_process"
import { createReadStream } from "node:fs"

import { COUNTRY_SURFACE_FORMS } from "@mailwoman/codex/country"
import { dataRootPath } from "@mailwoman/core/utils"
import { CSVSpliterator } from "spliterator"

import { stableSourceID } from "../adapter.ts"
import { alignRow } from "../align.ts"
import { type LocaleBaseTuple, type SynthesizedLocaleRow, synthesizeLocaleRow } from "../synthesize-german.ts"
import { makeMulberry32, type ShardRecipe } from "./scaffold.ts"

/**
 * One per-country OA source part: either a cached `zip` + `csv` member (streamed via `unzip -p`) or an extracted plain
 * `path` (streamed via `createReadStream`). Both carry the standard OA header
 * (LON,LAT,NUMBER,STREET,UNIT,CITY,DISTRICT,REGION,POSTCODE,ID,HASH). An optional `region` fallback covers countries
 * whose REGION column is empty (DE — the Bundesland is implied by the per-state file).
 */
export interface LocalePart {
	zip?: string
	csv?: string
	path?: string
	region?: string
	/**
	 * NZ — the OA DISTRICT column holds the city (`Auckland`) and CITY holds the suburb (`Birkenhead`). When set, map
	 * DISTRICT→locality and CITY→dependent_locality (falling back to CITY→locality when DISTRICT is empty, ~18% of NZ
	 * rows). Without this, the default CITY→locality mapping wrongly trains the suburb as the locality.
	 */
	districtAsLocality?: boolean
}

interface LocaleCountrySource {
	source: string
	parts: LocalePart[]
	/**
	 * The `corpus_version` stamped on emitted rows. DE/FR keep the historical `0.4.0` (regenerating those shards must
	 * stay lineage-identical); ES/IT/NL are the #241 staging lineage (`v0.9.9-es-it-nl`).
	 */
	corpusVersion: string
}

/**
 * Per-country OA sources + the source name used in the corpus. DE/FR still point at the legacy `/tmp/oa-cache` zips
 * (their historical build inputs — materialize them there to regenerate). ES/NL read the extracted countrywide CSVs and
 * IT the cached national zip under `$MAILWOMAN_DATA_ROOT` (#241; the fresh ES extract is OA-conformed, so the old
 * raw-CNIG conform map is gone). DE carries a per-part `region` fallback (its REGION column is empty; the
 * international-order tail needs it, #327). FR/NL/IT/ES REGION is populated per-row (ES = comunidad autónoma, IT =
 * regione, NL = province).
 */
const COUNTRY_SOURCES: Record<string, LocaleCountrySource> = {
	DE: {
		source: "synth-german",
		corpusVersion: "0.4.0",
		parts: [
			{ zip: "/tmp/oa-cache/de__berlin.zip", csv: "de/berlin.csv", region: "Berlin" },
			{ zip: "/tmp/oa-cache/de__sn__statewide.zip", csv: "de/sn/statewide.csv", region: "Sachsen" },
		],
	},
	FR: {
		source: "synth-fr",
		corpusVersion: "0.4.0",
		parts: [{ zip: "/tmp/oa-cache/fr__countrywide.zip", csv: "fr/countrywide.csv" }],
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
	},
	NZ: {
		// LINZ-derived OA countrywide extract (2.12M rows). `districtAsLocality` inverts the CITY/DISTRICT
		// mapping: DISTRICT holds the city (Auckland), CITY the suburb (Birkenhead). NZ OA carries no postcode.
		source: "synth-nz",
		corpusVersion: "0.9.9",
		// Eval holdout: a probe build excludes ~12% of NZ localities (a locality-bucket split) for a source-disjoint
		// coord board; that split is a BUILD-TIME concern (scratchpad), so the committed recipe reads the full CSV.
		parts: [{ path: dataRootPath("openaddresses", "extracted", "nz", "countrywide.csv"), districtAsLocality: true }],
	},
	GB: {
		// HM Land Registry Price Paid Data tuples (25.67M rows; see Task 2's ppd ingest). PPD's DISTRICT is the
		// postal town (locality) and CITY is the dependent locality — legitimately EMPTY on the majority of rows
		// (most GB addresses have no dependent locality). `districtAsLocality` maps DISTRICT→locality and, when
		// present, CITY→dependent_locality; the `readTuples` gate above only drops a row when BOTH are empty, so
		// the majority empty-CITY rows survive.
		source: "synth-gb",
		corpusVersion: "0.9.9",
		parts: [{ path: dataRootPath("ppd", "2026-07-22", "gb-tuples.csv"), districtAsLocality: true }],
	},
}

/**
 * Per-part reservoir cap. Streaming + Algorithm-R reservoir sampling to this size keeps memory bounded regardless of
 * source size, where buffering the whole CSV OOMs / overflows on FR/ES countrywide (~2.5 GB, ~25M rows). DE/NL-scale
 * sources (≤ ~1.2M) fit entirely, so they're sampled losslessly.
 */
const RESERVOIR_CAP = 1_200_000

/**
 * Fraction of NATIVE-order ES rows whose street→house join is space-collapsed (`CALLE MAYOR 12`) instead of the
 * template's comma (`CALLE MAYOR, 12`). Both are real Spanish surfaces — the comma is the official convention, the
 * space is what OA-derived feeds (and all 3,000 `openaddresses-es-sample.jsonl` rows) carry. 0.5 teaches both.
 */
const ES_SPACE_JOIN_FRACTION = 0.5

/**
 * Fraction of NL rows whose postcode keeps OA's glued shape (`1187LM`) instead of the spaced national convention (`1187
 * LM`). The eval sample is 100% glued; the conventional spaced form is the `1012 LM` two-letter-suffix shape the model
 * currently glues onto the city (#241). 0.5 teaches both.
 */
const NL_GLUED_POSTCODE_FRACTION = 0.5

/**
 * OA CITY-noise normalization (#241) — the documented cleaning step, derived from the 2026-07-02 FULL-STREAM audit of
 * the ES (15.6M rows), IT (13.9M), and NL (9.1M) sources (not a hand-list). Returns the cleaned city, or `null` to drop
 * the tuple.
 *
 * Cleaned classes:
 *
 * 1. DROP pseudo-localities — the ES cadastral aggregates (`Comunidad de 09076, 09150 y 09578`, `Ledanía de …`; 0.06% of
 *    ES rows): any CITY containing a comma or a ≥4-digit run is a land-register aggregate, not a renderable city.
 *    Structural, locale-safe — NL's genuine `2e Valthermond` (one digit) survives; IT/NL have zero hits.
 * 2. STRIP a trailing parenthesized 1–3-letter admin code — the NL BAG province disambiguator (`Bergen (NH)`, `Rijswijk
 *    (GLD)` → `Bergen`, `Rijswijk`; 0.13% of NL rows). The analogue of the German Kreis/region-suffix class (#241 names
 *    `Rabenau Sachs` / `Weißwasser /O.L.`): an admin-region gloss glued onto the locality value that dirties locality
 *    labels.
 *
 * Audit-verified NON-noise, deliberately NOT cleaned (a naive suffix rule would mangle real names):
 *
 * - ES/IT city-ends-with-province (`Alhama de Almería`, `GENZANO DI ROMA`; ~0.8% each): genuine toponyms whose linking
 *   `de`/`di` makes them full names, unlike the German glued-abbreviation class.
 * - ES bilingual slash names (`Laudio/Llodio`; 2.16%): official co-names — the eval expects them verbatim.
 * - IT ALL-CAPS city casing (98.79% of the source, and the eval's observed form): casing is the #829 case-augmentation
 *   lever, not this shard's.
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
}

/**
 * Stream real tuples out of an OA source part and reservoir-sample to {@link RESERVOIR_CAP}. Reads the CSV row-by-row —
 * `unzip -p | CSVSpliterator` for zip parts, `createReadStream | CSVSpliterator` for extracted parts (both bounded
 * memory) — and keeps a uniform random sample (Algorithm R) seeded by `rng`, separate from the emit loop's PRNG. NO
 * global dedup (a 25M-key Set would OOM; OA rows are near-unique). The city passes through {@link cleanCityNoise}; the
 * region falls back to `part.region` when the row's REGION cell is empty (DE).
 *
 * Exported for {@link locale.test.ts} — the CSV read path (quote handling, CRLF, region fallback) has no other test.
 */
export async function readTuples(part: LocalePart, rng: () => number): Promise<LocaleBaseTuple[]> {
	let input: NodeJS.ReadableStream

	if (part.path) {
		// No `encoding` — CSVSpliterator delimits raw bytes and decodes utf-8 itself; a string stream
		// (from `{ encoding: "utf8" }`) would defeat its byte-range scanner.
		input = createReadStream(part.path)
	} else {
		const child = spawn("unzip", ["-p", part.zip!, part.csv!])
		child.on("error", (err) => {
			console.error(`  WARN: unzip failed for ${part.zip}: ${err.message}`)
		})
		input = child.stdout!
	}
	const get = (cells: string[], i: number): string => (i >= 0 && i < cells.length ? (cells[i] ?? "").trim() : "")
	const reservoir: LocaleBaseTuple[] = []
	let cols: ColumnIndex | null = null
	let header: string[] | null = null
	let seen = 0
	let dropped = 0

	try {
		// CSVSpliterator handles OA's quoted fields (embedded commas/newlines) and CRLF row terminators
		// (spliterator ≥ 3.2.0); `header: false` yields the header row too, so we build the column index
		// from it exactly as the prior hand-rolled split did. Verified byte-identical tuples vs that split
		// on 10M+ real OA rows — the only raw-cell difference was a trailing CR on the discarded HASH column.
		for await (const cells of CSVSpliterator.fromAsync<string[]>(input, {
			mode: "array",
			header: false,
			enableQuoteHandling: true,
		})) {
			if (header === null) {
				header = cells.map((h) => h.trim().toLowerCase())
				const ix = (name: string): number => header!.indexOf(name)
				cols = {
					num: ix("number"),
					street: ix("street"),
					city: ix("city"),
					district: ix("district"),
					region: ix("region"),
					post: ix("postcode"),
				}

				continue
			}

			if (cols === null) continue
			const street = get(cells, cols.street)
			const rawCity = get(cells, cols.city)

			if (!street) continue

			// Default: CITY → locality. NZ/GB (`districtAsLocality`) inverts it — the OA DISTRICT holds the city
			// (`Auckland`) and CITY holds the suburb (`Birkenhead`), so DISTRICT → locality and CITY →
			// dependent_locality. When DISTRICT is empty (~18% of NZ rows), fall back to CITY → locality with no
			// sub-locality. GB PPD tuples flip which side is legitimately empty — on the MAJORITY of GB rows CITY
			// (the dependent_locality) is empty and DISTRICT (the locality) is populated, so the gate below only
			// drops a `districtAsLocality` row when BOTH are empty, not when CITY alone is (that used to silently
			// drop most of the GB source — see the fixed `readTuples` gate below). See
			// {@link LocalePart.districtAsLocality}.
			let locality: string | null
			let dependent_locality: string | undefined

			if (part.districtAsLocality) {
				const rawDistrict = get(cells, cols.district)

				if (!rawCity && !rawDistrict) continue

				const cleanedDistrict = cleanCityNoise(rawDistrict)

				if (cleanedDistrict) {
					locality = cleanedDistrict
					dependent_locality = cleanCityNoise(rawCity) ?? undefined
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
	} catch (err) {
		console.error(`  WARN: read failed for ${part.path ?? part.zip}: ${(err as Error).message}`)

		return []
	}

	console.error(`  ${part.path ?? part.csv}: ${reservoir.length} sampled of ${seen} rows (${dropped} city-noise drops)`)

	return reservoir
}

/**
 * Country-append fraction (the fr-admin-split #728 pattern, generalized to the locale recipe): mutates `synth` in
 * place, `countryFraction` of the time appending an explicit country surface form ("United Kingdom") to `raw` + a
 * `country` component — the model relearns to emit country WHEN the token is present without over-firing it on the
 * (still-majority) country-less rows. `countryFraction <= 0` (the default) short-circuits the `random()` draw away
 * entirely — no `synth` mutation and no RNG consumption — so every existing locale's emit stream stays byte-identical
 * to before this option existed. Exported for {@link locale.test.ts}.
 */
export function applyCountryAppend(
	synth: SynthesizedLocaleRow,
	country: string,
	countryFraction: number,
	random: () => number
): void {
	if (countryFraction > 0 && random() < countryFraction) {
		const forms = COUNTRY_SURFACE_FORMS[country as keyof typeof COUNTRY_SURFACE_FORMS]

		if (forms?.length) {
			const form = forms[Math.floor(random() * forms.length)]!
			synth.raw = `${synth.raw}, ${form}`
			synth.components = { ...synth.components, country: form }
		}
	}
}

export const localeRecipe: ShardRecipe = {
	name: "locale",
	description: "Per-locale coverage rows (DE/FR/NL/IT/ES/NZ/GB) from real OA tuples, both orders → synthesizeLocaleRow",
	mode: "generate",
	options: [
		{ flag: "--country <cc>", description: "Target country (DE|FR|NL|IT|ES|NZ|GB). Default DE" },
		{ flag: "--intl-fraction <f>", description: "Fraction rendered international order. Default 0.4" },
		{
			flag: "--country-fraction <f>",
			description:
				"Fraction of rows that append an explicit country surface form (`, United Kingdom`) + a `country` component (fr-admin-split pattern). Default 0 — byte-identical to before when unset.",
		},
	],
	async run(opts, write) {
		// Emit PRNG: the legacy build-locale-shard.mjs seeded mulberry32(opts.seed). The reservoir uses a
		// SEPARATE per-part mulberry32 (below) so input sampling never perturbs this emit stream.
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
		// Default 0 → the `random() < countryFraction` draw below is short-circuited away entirely (never
		// consumed), so every existing locale's emit stream is byte-identical to before this option existed.
		const countryFraction = opts.countryFraction ?? 0

		if (!(countryFraction >= 0 && countryFraction <= 1)) {
			throw new Error(`--country-fraction must be in [0, 1], got ${countryFraction}`)
		}
		const source = opts.sourceName ?? countrySource.source
		const count = opts.count ?? 4000
		const { parts } = countrySource

		const pool: LocaleBaseTuple[] = []

		for (let pi = 0; pi < parts.length; pi++) {
			// A reservoir PRNG per part, seeded but independent of the emit loop's `random`, so the sample is
			// reproducible without perturbing the synth/order draws.
			const reservoirRng = makeMulberry32((opts.seed ^ (0x9e3779b9 * (pi + 1))) >>> 0)
			const t = await readTuples(parts[pi]!, reservoirRng)

			for (const x of t) {
				pool.push(x)
			} // NOT pool.push(...t) — spreading huge arrays overflows the stack
		}

		if (pool.length === 0) {
			throw new Error(`No ${country} tuples found — are the source CSVs/zips present? (see COUNTRY_SOURCES)`)
		}

		let emitted = 0
		let skipped = 0
		let guard = 0
		const N = pool.length

		while (emitted < count && guard++ < count * 6) {
			const base = pool[Math.floor(random() * N)]!
			const order = random() < intlFraction ? "international" : "native"
			// Per-country surface-shape draws (#241) — consumed ONLY for that country, so the DE/FR emit
			// streams for a given seed are unchanged by their existence.
			const nativeHouseJoin =
				country === "ES" ? (random() < ES_SPACE_JOIN_FRACTION ? ("space" as const) : ("template" as const)) : undefined
			const postcodeShape =
				country === "NL"
					? random() < NL_GLUED_POSTCODE_FRACTION
						? ("as-source" as const)
						: ("conventional" as const)
					: undefined
			const synth = synthesizeLocaleRow(base, country, { random, order, nativeHouseJoin, postcodeShape })

			if (!synth) {
				skipped++
				continue
			}
			applyCountryAppend(synth, country, countryFraction, random)

			if (opts.golden) {
				// Golden rows must round-trip through alignRow exactly like training rows (#241 done-when): a
				// render that can't be BIO-labeled can't serve as a parser golden either. Consumes no RNG draw.
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
				write(JSON.stringify({ raw: synth.raw, components: synth.components, country, order }) + "\n")
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
			write(JSON.stringify({ ...aligned.row, synth_method: source, synth_order: order, synth_base_id: null }) + "\n")
			emitted++
		}

		return { emitted, skipped }
	},
}
