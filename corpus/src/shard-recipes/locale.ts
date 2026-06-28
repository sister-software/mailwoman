/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `locale` shard recipe — the multi-locale generalization of the `german` recipe. Reads REAL
 *   OpenAddresses tuples for a `--country` (DE/FR/NL/IT/ES), renders each via
 *   {@link synthesizeLocaleRow} in BOTH orders (`--intl-fraction`, default 0.4 international / the
 *   rest country-native), aligns to BIO, and emits a labeled JSONL. Generate-mode: it STREAMS each
 *   source CSV (`unzip -p | readline`) and reservoir-samples to {@link RESERVOIR_CAP} (so FR/ES
 *   countrywide work in bounded memory), then draws `--count` rows from the pool with the passed
 *   `random`. Ported from scripts/build-locale-shard.mjs.
 *
 *   The reservoir uses its OWN seeded PRNG ({@link mulberry32}, per part), independent of the emit
 *   `random`, so the input sample is reproducible WITHOUT perturbing the synth/order draws.
 */

import { spawn } from "node:child_process"
import { createInterface } from "node:readline"

import { stableSourceId } from "../adapter.js"
import { alignRow } from "../align.js"
import { type LocaleBaseTuple, synthesizeLocaleRow } from "../synthesize-german.js"
import { makeMulberry32, type ShardRecipe } from "./scaffold.js"

/**
 * A conform map ({number, street, city, region, postcode} → raw column names; `street` as an array space-joins) for an
 * upstream that isn't OA-conformed — ES uses it (the raw CNIG schema).
 */
interface ConformMap {
	number: string
	street: string | string[]
	city: string
	region?: string
	postcode: string
}

/** One per-country OA source part (cached zip) + optional region fallback / conform map. */
interface LocalePart {
	zip: string
	csv: string
	region?: string
	conform?: ConformMap
}

interface LocaleCountrySource {
	source: string
	parts: LocalePart[]
}

/**
 * Per-country OA sources (cached zips) + the source name used in the corpus. A part may carry a `region` fallback (the
 * admin region the file covers) for countries whose OA REGION column is empty — DE's is, so the international-order
 * tail needs it set per-state (#327). FR/NL/IT leave it unset (their REGION column is populated, used per-row). ES
 * carries a `conform` map (the raw CNIG schema).
 */
const COUNTRY_SOURCES: Record<string, LocaleCountrySource> = {
	DE: {
		source: "synth-german",
		parts: [
			{ zip: "/tmp/oa-cache/de__berlin.zip", csv: "de/berlin.csv", region: "Berlin" },
			{ zip: "/tmp/oa-cache/de__sn__statewide.zip", csv: "de/sn/statewide.csv", region: "Sachsen" },
		],
	},
	FR: { source: "synth-fr", parts: [{ zip: "/tmp/oa-cache/fr__countrywide.zip", csv: "fr/countrywide.csv" }] },
	NL: { source: "synth-nl", parts: [{ zip: "/tmp/oa-cache/nl__countrywide.zip", csv: "nl/countrywide.csv" }] },
	// IT: 5-digit postcode; OA REGION populated (the regione) → international rows carry the tail.
	IT: { source: "synth-it", parts: [{ zip: "/tmp/oa-cache/it__countrywide.zip", csv: "it/countrywide.csv" }] },
	// ES: the raw CNIG/IGN national set (NOT OA-conformed), via a `conform` map: street = join(tipo_vial,
	// nombre_via); region = comunidad_autonoma (POPULATED → international "City, Comunidad Postcode" tail).
	ES: {
		source: "synth-es",
		parts: [
			{
				zip: "/tmp/oa-cache/es__countrywide.zip",
				csv: "es_addresses.csv",
				conform: {
					number: "numero",
					street: ["tipo_vial", "nombre_via"],
					city: "municipio",
					region: "comunidad_autonoma",
					postcode: "cod_postal",
				},
			},
		],
	},
}

/**
 * Per-part reservoir cap. Streaming + Algorithm-R reservoir sampling to this size keeps memory bounded regardless of
 * source size, where buffering the whole CSV OOMs / overflows on FR/ES countrywide (~2.5 GB, ~25M rows). DE/NL-scale
 * sources (≤ ~1.2M) fit entirely, so they're sampled losslessly.
 */
const RESERVOIR_CAP = 1_200_000

/** Minimal RFC-4180-ish splitter (handles quoted fields). */
function splitCsv(line: string): string[] {
	const out: string[] = []
	let cur = ""
	let inQ = false

	for (let i = 0; i < line.length; i++) {
		const c = line[i]!

		if (inQ) {
			if (c === '"') {
				if (line[i + 1] === '"') {
					cur += '"'
					i++
				} else inQ = false
			} else cur += c
		} else if (c === '"') inQ = true
		else if (c === ",") {
			out.push(cur)
			cur = ""
		} else cur += c
	}
	out.push(cur)

	return out
}

interface ColumnIndex {
	num: number
	streetParts: number[]
	city: number
	region: number
	post: number
}

/**
 * Stream real tuples out of a cached OA zip and reservoir-sample to {@link RESERVOIR_CAP}. Reads the CSV line-by-line
 * via `unzip -p | readline` (bounded memory) and keeps a uniform random sample (Algorithm R) seeded by `rng` — separate
 * from the emit loop's PRNG. NO global dedup (a 25M-key Set would OOM; OA rows are near-unique). The region falls back
 * to `part.region` when the row's REGION cell is empty (DE).
 */
function readTuples(part: LocalePart, rng: () => number): Promise<LocaleBaseTuple[]> {
	return new Promise((resolve) => {
		const child = spawn("unzip", ["-p", part.zip, part.csv])
		const rl = createInterface({ input: child.stdout!, crlfDelay: Infinity })
		const get = (cells: string[], i: number): string => (i >= 0 && i < cells.length ? (cells[i] ?? "").trim() : "")
		const reservoir: LocaleBaseTuple[] = []
		let cols: ColumnIndex | null = null
		let header: string[] | null = null
		let seen = 0
		rl.on("line", (line) => {
			if (!line) return

			if (header === null) {
				header = splitCsv(line).map((h) => h.trim().toLowerCase())
				const ix = (name: string): number => header!.indexOf(String(name).toLowerCase())
				// OA-standard columns (IT/FR/NL/DE), unless the part carries a `conform` map for a raw
				// upstream schema (ES — CNIG columns, street split across `tipo_vial` + `nombre_via`).
				const c = part.conform
				cols = c
					? {
							num: ix(c.number),
							streetParts: (Array.isArray(c.street) ? c.street : [c.street]).map(ix),
							city: ix(c.city),
							region: c.region ? ix(c.region) : -1,
							post: ix(c.postcode),
						}
					: {
							num: ix("number"),
							streetParts: [ix("street")],
							city: ix("city"),
							region: ix("region"),
							post: ix("postcode"),
						}

				return
			}

			if (cols === null) return
			const cells = splitCsv(line)
			const street = cols.streetParts
				.map((i) => get(cells, i))
				.filter(Boolean)
				.join(" ")
				.trim()
			const locality = get(cells, cols.city)

			if (!street || !locality) return
			const tuple: LocaleBaseTuple = {
				house_number: get(cells, cols.num),
				street,
				locality,
				region: get(cells, cols.region) || part.region || "",
				postcode: get(cells, cols.post),
			}
			seen++

			if (reservoir.length < RESERVOIR_CAP) {
				reservoir.push(tuple)
			} else {
				const j = Math.floor(rng() * seen)

				// 0 .. seen-1
				if (j < RESERVOIR_CAP) reservoir[j] = tuple
			}
		})
		rl.on("close", () => {
			console.error(`  ${part.csv}: ${reservoir.length} sampled of ${seen} rows`)
			resolve(reservoir)
		})
		child.on("error", (err) => {
			console.error(`  WARN: unzip failed for ${part.zip}: ${err.message}`)
			resolve([])
		})
	})
}

export const localeRecipe: ShardRecipe = {
	name: "locale",
	description: "Per-locale coverage rows (DE/FR/NL/IT/ES) from real OA tuples, both orders → synthesizeLocaleRow",
	mode: "generate",
	options: [
		{ flag: "--country <cc>", description: "Target country (DE|FR|NL|IT|ES). Default DE" },
		{ flag: "--intl-fraction <f>", description: "Fraction rendered international order. Default 0.4" },
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
		const source = opts.sourceName ?? countrySource.source
		const count = opts.count ?? 4000
		const { parts } = countrySource

		const pool: LocaleBaseTuple[] = []

		for (let pi = 0; pi < parts.length; pi++) {
			// A reservoir PRNG per part, seeded but independent of the emit loop's `random`, so the sample is
			// reproducible without perturbing the synth/order draws.
			const reservoirRng = makeMulberry32((opts.seed ^ (0x9e3779b9 * (pi + 1))) >>> 0)
			const t = await readTuples(parts[pi]!, reservoirRng)

			for (const x of t) pool.push(x) // NOT pool.push(...t) — spreading huge arrays overflows the stack
		}

		if (pool.length === 0) {
			throw new Error(`No ${country} tuples found — are the cached zips present in /tmp/oa-cache?`)
		}

		let emitted = 0
		let skipped = 0
		let guard = 0
		const N = pool.length

		while (emitted < count && guard++ < count * 6) {
			const base = pool[Math.floor(random() * N)]!
			const order = random() < intlFraction ? "international" : "native"
			const synth = synthesizeLocaleRow(base, country, { random, order })

			if (!synth) {
				skipped++
				continue
			}

			if (opts.golden) {
				write(JSON.stringify({ raw: synth.raw, components: synth.components, country, order }) + "\n")
				emitted++
				continue
			}
			const sourceId = stableSourceId(source, {
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
				source_id: sourceId,
				corpus_version: "0.4.0",
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
