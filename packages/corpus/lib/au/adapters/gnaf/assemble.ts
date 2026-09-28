/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Assemble a sampled, component-labeled Australian address set from G-NAF (the Geocoded National
 * Address File, Geoscape Australia, Open G-NAF licence). Any derived artifact must attribute
 * "Geoscape Australia". G-NAF is a relational PSV distribution whose street address reconstructs
 * by joining ADDRESS_DETAIL (number, postcode, the PIDs) to STREET_LOCALITY (street name and type)
 * and then to locality (suburb). State is the per-file prefix (ACT/NSW/…).
 *
 * The two lookup tables load as Maps. ADDRESS_DETAIL streams once and is reservoir-sampled, so
 * memory stays bounded.
 *
 * No coordinates. The output feeds the parser. The parser needs the address string and its component
 * labels. Output is component tuples as jsonl. An optional held-out eval set is excluded by
 * (street, locality, postcode) so the training corpus never overlaps the benchmark.
 */

import { tryParsingJSON, stringifyJSON } from "@mailwoman/core/json"
import { PathBuilder, type PathBuilderLike } from "path-ts"
import { titleCase, createNewlineWriter, PSVSpliterator, TextSpliterator } from "spliterator"
import { Globerator } from "spliterator/node/fs"

export interface GNAFAssembleOptions {
	/**
	 * G-NAF `Standard` directory (holds the per-state `*_psv.psv` tables).
	 */
	standardDir: PathBuilderLike
	/**
	 * Target sample size (uniform reservoir → population-proportional across states).
	 */
	sampleSize: number
	/**
	 * Output jsonl path.
	 */
	out: string
	/**
	 * Optional held-out eval jsonl (rows with a `components` field) —
	 * its (street,locality,postcode) are excluded.
	 */
	holdoutPath?: string
	/**
	 * Progress sink (the CLI passes a setter).
	 */
	onProgress?: (message: string) => void
}

export interface GNAFAssembleResult {
	written: number
	seen: number
	heldOut: number
	byState: Record<string, number>
}

/**
 * Holdout/dedup key: a street within a locality+postcode (house-number-agnostic — conservative).
 */
export function gnafHoldoutKey(street: string, locality: string, postcode: string): string {
	return `${street}|${locality}|${postcode}`.toLowerCase()
}

type Row = Record<string, string | number | undefined>

async function* psvObjects(path: string): AsyncIterable<Row> {
	yield* PSVSpliterator.fromAsync(path) as AsyncIterable<Row>
}

/**
 * Load a small lookup table fully into a Map keyed by `keyCol`.
 */
async function loadMap<V>(paths: string[], keyCol: string, pick: (r: Row) => V): Promise<Map<string, V>> {
	const m = new Map<string, V>()

	for (const p of paths) {
		for await (const r of psvObjects(p)) {
			const k = r[keyCol]

			if (k != null && k !== "") {
				m.set(String(k), pick(r))
			}
		}
	}

	return m
}

/**
 * Build the held-out key set from an eval jsonl whose rows contain a `components` object.
 */
async function loadHoldout(path: string): Promise<Set<string>> {
	const keys = new Set<string>()

	for await (const line of TextSpliterator.fromAsync(path)) {
		const c = tryParsingJSON<{ components?: Record<string, string> }>(line)?.components

		if (c?.street && c?.locality && c?.postcode) {
			keys.add(gnafHoldoutKey(c.street, c.locality, c.postcode))
		}
	}

	return keys
}

export async function assembleGNAF(opts: GNAFAssembleOptions): Promise<GNAFAssembleResult> {
	const progress = opts.onProgress ?? (() => {})
	const standardDir = PathBuilder.from(opts.standardDir)
	const files = await Globerator.from("*", { cwd: standardDir, absolute: false }).toArray()

	// Strings, because the address loop reads the state code out of each path.
	const pick = (re: RegExp, exclude?: RegExp) =>
		files.filter((f) => re.test(f) && !(exclude && exclude.test(f))).map((f) => standardDir(f).toString())

	// `*_LOCALITY_psv.psv` also globs `*_STREET_LOCALITY_psv.psv` — exclude the latter explicitly.
	const streetPaths = pick(/_STREET_LOCALITY_psv\.psv$/)
	const localityPaths = pick(/_LOCALITY_psv\.psv$/, /_STREET_LOCALITY_psv\.psv$/)
	const addressPaths = pick(/_ADDRESS_DETAIL_psv\.psv$/)

	const holdout = opts.holdoutPath ? await loadHoldout(opts.holdoutPath) : new Set<string>()

	if (opts.holdoutPath) {
		progress(`held-out eval keys: ${holdout.size}`)
	}

	progress(`loading STREET_LOCALITY (${streetPaths.length} files) + LOCALITY (${localityPaths.length})…`)

	const streetMap = await loadMap(streetPaths, "street_locality_pid", (r) => ({
		name: String(r.street_name ?? ""),
		type: String(r.street_type_code ?? ""),
		suffix: String(r.street_suffix_code ?? ""),
	}))

	const localityMap = await loadMap(localityPaths, "locality_pid", (r) => String(r.locality_name ?? ""))
	progress(`streets=${streetMap.size.toLocaleString()} localities=${localityMap.size.toLocaleString()}`)

	const reservoir: Array<{ house_number: string; street: string; locality: string; region: string; postcode: string }> =
		[]

	let seen = 0
	let heldOut = 0

	for (const p of addressPaths) {
		const state = (p.match(/\/([A-Z]+)_ADDRESS_DETAIL/) ?? [])[1] ?? ""

		for await (const r of psvObjects(p)) {
			const numberFirst = String(r.number_first ?? "")

			if (!numberFirst || r.date_retired || !r.postcode) continue
			const st = streetMap.get(String(r.street_locality_pid ?? ""))
			const suburbRaw = localityMap.get(String(r.locality_pid ?? ""))

			if (!st?.name || !suburbRaw) continue
			const street = `${titleCase(st.name)} ${titleCase(st.type)}${st.suffix ? " " + titleCase(st.suffix) : ""}`.trim()
			const locality = titleCase(suburbRaw)
			const postcode = String(r.postcode)

			if (holdout.has(gnafHoldoutKey(street, locality, postcode))) {
				heldOut++

				continue
			}

			let house = numberFirst + (r.number_first_suffix ? String(r.number_first_suffix) : "")

			if (r.number_last) {
				house = `${house}-${String(r.number_last)}`
			}

			if (r.flat_number) {
				house = `${String(r.flat_number)}/${house}`
			}

			const tuple = { house_number: house, street, locality, region: state, postcode }

			seen++

			if (reservoir.length < opts.sampleSize) {
				reservoir.push(tuple)
			} else {
				const j = Math.floor(Math.random() * seen)

				if (j < opts.sampleSize) {
					reservoir[j] = tuple
				}
			}
		}

		progress(`${state}: ${seen.toLocaleString()} valid joinable seen`)
	}

	const byState: Record<string, number> = {}

	{
		await using out = createNewlineWriter(opts.out)

		for (const t of reservoir) {
			await out.write(stringifyJSON(t))
			byState[t.region] = (byState[t.region] ?? 0) + 1
		}
	}

	progress(`wrote ${reservoir.length.toLocaleString()} tuples → ${opts.out}`)

	return { written: reservoir.length, seen, heldOut, byState }
}
