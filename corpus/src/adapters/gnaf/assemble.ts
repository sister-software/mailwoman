/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Assemble a sampled, component-labeled Australian address set from G-NAF (the Geocoded National
 *   Address File — Geoscape Australia, Open G-NAF licence; any derived artifact must attribute
 *   "Geoscape Australia"). G-NAF is a relational PSV distribution (~16.9M addresses); reconstructing a
 *   street address joins three tables — ADDRESS_DETAIL (number, postcode, the PIDs) → STREET_LOCALITY
 *   (street name + type) → LOCALITY (suburb). State is the per-file prefix (ACT/NSW/…).
 *
 *   Streaming + in-memory join via the house {@link PSVSpliterator} (pipe-separated; `mode: "object"`
 *   keys each row by its header) — NOT raw `read_csv` SQL, which a flat-file join doesn't need and
 *   which the #183–190 cleanup retired. The two lookup tables (STREET_LOCALITY ~765k rows, LOCALITY
 *   ~16k) fit as Maps; ADDRESS_DETAIL is streamed once and reservoir-sampled, so memory stays bounded
 *   (the OOM lesson from the Overture ingest).
 *
 *   No coordinates: the output feeds the PARSER ({@link ../gnaf/adapter}, #208) — teaching the model
 *   AU's postcode-first / house-number-last word order, the gap `scripts/eval/au-order-probe.ts`
 *   pinned (65%→87% if the parse were order-robust). The parser needs the address string + component
 *   labels, not lat/lon.
 *
 *   Output: component tuples as JSONL, consumed by the `gnaf` corpus adapter (which renders them in
 *   multiple orders + the corpus aligner BIO-labels them). An optional held-out eval set is excluded
 *   by (street, locality, postcode) so the training shard never overlaps the benchmark.
 */

import { createWriteStream } from "node:fs"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { PSVSpliterator } from "spliterator"

export interface GnafAssembleOptions {
	/** G-NAF `Standard` directory (holds the per-state `*_psv.psv` tables). */
	standardDir: string
	/** Target sample size (uniform reservoir → population-proportional across states). */
	sampleSize: number
	/** Output JSONL path. */
	out: string
	/** Optional held-out eval JSONL (rows with a `components` field) — its (street,locality,postcode) are excluded. */
	holdoutPath?: string
	/** Progress sink (the CLI passes a setter). */
	onProgress?: (message: string) => void
}

export interface GnafAssembleResult {
	written: number
	seen: number
	heldOut: number
	byState: Record<string, number>
}

/** UPPERCASE → Title Case, preserving intra-word apostrophes/hyphens (O'Brien, Coff's Harbour). */
export function titlecase(s: string): string {
	return s
		.toLowerCase()
		.replace(/(^|[\s'\-/])([a-z])/g, (_m, p: string, c: string) => p + c.toUpperCase())
		.trim()
}

/** Holdout/dedup key: a street within a locality+postcode (house-number-agnostic — conservative). */
export function gnafHoldoutKey(street: string, locality: string, postcode: string): string {
	return `${street}|${locality}|${postcode}`.toLowerCase()
}

type Row = Record<string, string | number | undefined>
async function* psvObjects(path: string): AsyncIterable<Row> {
	yield* PSVSpliterator.fromAsync(path, { mode: "object", header: true }) as AsyncIterable<Row>
}

/** Load a small lookup table fully into a Map keyed by `keyCol`. */
async function loadMap<V>(paths: string[], keyCol: string, pick: (r: Row) => V): Promise<Map<string, V>> {
	const m = new Map<string, V>()
	for (const p of paths) {
		for await (const r of psvObjects(p)) {
			const k = r[keyCol]
			if (k != null && k !== "") m.set(String(k), pick(r))
		}
	}
	return m
}

/** Build the held-out key set from an eval JSONL whose rows carry a `components` object. */
async function loadHoldout(path: string): Promise<Set<string>> {
	const keys = new Set<string>()
	const text = await readFile(path, "utf8")
	for (const line of text.split("\n")) {
		if (!line.trim()) continue
		try {
			const c = (JSON.parse(line) as { components?: Record<string, string> }).components
			if (c?.street && c?.locality && c?.postcode) keys.add(gnafHoldoutKey(c.street, c.locality, c.postcode))
		} catch {
			/* skip malformed */
		}
	}
	return keys
}

export async function assembleGnaf(opts: GnafAssembleOptions): Promise<GnafAssembleResult> {
	const progress = opts.onProgress ?? (() => {})
	const files = await readdir(opts.standardDir)
	const pick = (re: RegExp, exclude?: RegExp) =>
		files.filter((f) => re.test(f) && !(exclude && exclude.test(f))).map((f) => join(opts.standardDir, f))

	// `*_LOCALITY_psv.psv` also globs `*_STREET_LOCALITY_psv.psv` — exclude the latter explicitly.
	const streetPaths = pick(/_STREET_LOCALITY_psv\.psv$/)
	const localityPaths = pick(/_LOCALITY_psv\.psv$/, /_STREET_LOCALITY_psv\.psv$/)
	const addressPaths = pick(/_ADDRESS_DETAIL_psv\.psv$/)

	const holdout = opts.holdoutPath ? await loadHoldout(opts.holdoutPath) : new Set<string>()
	if (opts.holdoutPath) progress(`held-out eval keys: ${holdout.size}`)

	progress(`loading STREET_LOCALITY (${streetPaths.length} files) + LOCALITY (${localityPaths.length})…`)
	const streetMap = await loadMap(streetPaths, "STREET_LOCALITY_PID", (r) => ({
		name: String(r.STREET_NAME ?? ""),
		type: String(r.STREET_TYPE_CODE ?? ""),
		suffix: String(r.STREET_SUFFIX_CODE ?? ""),
	}))
	const localityMap = await loadMap(localityPaths, "LOCALITY_PID", (r) => String(r.LOCALITY_NAME ?? ""))
	progress(`streets=${streetMap.size.toLocaleString()} localities=${localityMap.size.toLocaleString()}`)

	const reservoir: Array<{ house_number: string; street: string; locality: string; region: string; postcode: string }> = []
	let seen = 0
	let heldOut = 0
	for (const p of addressPaths) {
		const state = (p.match(/\/([A-Z]+)_ADDRESS_DETAIL/) ?? [])[1] ?? ""
		for await (const r of psvObjects(p)) {
			const numberFirst = String(r.NUMBER_FIRST ?? "")
			if (!numberFirst || r.DATE_RETIRED || !r.POSTCODE) continue
			const st = streetMap.get(String(r.STREET_LOCALITY_PID ?? ""))
			const suburbRaw = localityMap.get(String(r.LOCALITY_PID ?? ""))
			if (!st?.name || !suburbRaw) continue
			const street = `${titlecase(st.name)} ${titlecase(st.type)}${st.suffix ? " " + titlecase(st.suffix) : ""}`.trim()
			const locality = titlecase(suburbRaw)
			const postcode = String(r.POSTCODE)
			if (holdout.has(gnafHoldoutKey(street, locality, postcode))) {
				heldOut++
				continue
			}
			let house = numberFirst + (r.NUMBER_FIRST_SUFFIX ? String(r.NUMBER_FIRST_SUFFIX) : "")
			if (r.NUMBER_LAST) house = `${house}-${String(r.NUMBER_LAST)}`
			if (r.FLAT_NUMBER) house = `${String(r.FLAT_NUMBER)}/${house}`
			const tuple = { house_number: house, street, locality, region: state, postcode }
			seen++
			if (reservoir.length < opts.sampleSize) reservoir.push(tuple)
			else {
				const j = Math.floor(Math.random() * seen)
				if (j < opts.sampleSize) reservoir[j] = tuple
			}
		}
		progress(`${state}: ${seen.toLocaleString()} valid joinable seen`)
	}

	const out = createWriteStream(opts.out)
	const byState: Record<string, number> = {}
	for (const t of reservoir) {
		out.write(JSON.stringify(t) + "\n")
		byState[t.region] = (byState[t.region] ?? 0) + 1
	}
	await new Promise<void>((res) => out.end(res))
	progress(`wrote ${reservoir.length.toLocaleString()} tuples → ${opts.out}`)
	return { written: reservoir.length, seen, heldOut, byState }
}
