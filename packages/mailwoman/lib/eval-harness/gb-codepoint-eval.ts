/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   GB postcode-resolution evaluation against OS Code-Point Open, whose centroids are also the GB gazetteer source,
 *   so this measures the parse → retrieval → resolution pipeline at postcode scale rather than independent coordinate accuracy.
 *
 *   Contains OS data © Crown copyright and database right 2026 (Code-Point Open, OGL v3).
 *
 *   Run: node packages/mailwoman/lib/eval-harness/gb-codepoint-eval.ts [--stamp 2026-08-05] [--per-area 5] [--out <jsonl>]
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { writeLocalJSONLFile } from "@mailwoman/core/fs/writers"
import { mulberry32 } from "@mailwoman/core/random"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { haversineKm, osgb36ToWGS84 } from "@mailwoman/spatial"
import { basename, type PathBuilder } from "path-ts"
import { Globerator } from "spliterator/node/fs"

import { createGeocodeCommandOptions } from "#geocode/command-options"
import { createGeocodeSession } from "#geocode/session"

interface SampledPostcode {
	area: string
	postcode: string
	lat: number
	lon: number
}

interface LegResult {
	postcode: string
	area: string
	leg: string
	locale: string
	resolved: boolean
	km: number | null
}

const THRESHOLDS_KM = [1, 5, 25] as const

/**
 * Positional-quality value meaning "no coordinate available", dropped to match `codepoint-database.ts`.
 */
const PQ_NO_COORDINATE = 90

/**
 * Every postcode in the acquisition, folded to unspaced-uppercase — the existence oracle
 * for the typo leg, where a mutant landing on a real neighbouring unit must resolve
 * and only one absent from the register demands abstention.
 */
async function allPostcodes(csvDir: PathBuilder): Promise<Set<string>> {
	const out = new Set<string>()

	for await (const file of Globerator.files("csv", { cwd: csvDir, absolute: false, recursive: false })) {
		// oxlint-disable-next-line mailwoman/prefer-spliterator -- bounded input, one pass
		for (const line of (await readLocalTextFile(csvDir(file))).split("\n")) {
			const pc = line.split(",")[0]?.replaceAll('"', "").trim()

			if (pc) {
				out.add(pc.replaceAll(" ", "").toUpperCase())
			}
		}
	}

	return out
}

async function samplePostcodes(csvDir: PathBuilder, perArea: number, seed: number): Promise<SampledPostcode[]> {
	const random = mulberry32(seed)
	const out: SampledPostcode[] = []

	for (const file of await Globerator.files("csv", { cwd: csvDir, absolute: false, recursive: false }).toSorted()) {
		const rows: SampledPostcode[] = []

		// Code-Point area files are small (the largest ~90k rows); whole-file split is bounded here.
		// oxlint-disable-next-line mailwoman/prefer-spliterator -- bounded input, one pass
		for (const line of (await readLocalTextFile(csvDir(file))).split("\n")) {
			if (!line) continue
			// Code-Point carries no embedded commas inside quotes, so a plain split is faithful to this source.
			const cols = line.split(",")
			const pq = Number(cols[1])

			if (pq === PQ_NO_COORDINATE) continue
			const postcode = (cols[0] ?? "").replaceAll('"', "").trim()
			const easting = Number(cols[2])
			const northing = Number(cols[3])

			if (!postcode || !Number.isFinite(easting) || !Number.isFinite(northing)) continue
			const wgs = osgb36ToWGS84({ easting, northing })

			rows.push({ area: basename(file, ".csv"), postcode, lat: wgs.latitude, lon: wgs.longitude })
		}

		for (let i = 0; i < perArea && rows.length; i++) {
			const idx = Math.floor(random() * rows.length)

			out.push(rows[idx]!)
			rows.splice(idx, 1)
		}
	}

	return out
}

function legsFor(postcode: string): Array<{ leg: string; input: string }> {
	return [
		{ leg: "as_published", input: postcode },
		{ leg: "lower_unspaced", input: postcode.toLowerCase().replaceAll(" ", "") },
		{ leg: "uk_suffixed", input: `${postcode}, UK` },
		// A mutant absent from the register demands abstention; a real neighbouring unit must resolve like any postcode.
		{ leg: "typo", input: mutateFinalLetter(postcode) },
	]
}

/**
 * Swap the final letter for its alphabet successor (Z→A), skipping the letters GB unit postcodes never use in final position.
 */
function mutateFinalLetter(postcode: string): string {
	const last = postcode.at(-1)!
	const next = last === "Z" ? "A" : String.fromCharCode(last.charCodeAt(0) + 1)

	return postcode.slice(0, -1) + next
}

const { values } = parseArguments({
	options: {
		stamp: { type: "string", default: "2026-08-05" },
		"per-area": { type: "string", default: "5" },
		seed: { type: "string", default: "20260818" },
		out: { type: "string" },
	},
})

const csvDir = dataRootPath("codepoint", values.stamp!, "Data", "CSV")
const perArea = Number.parseInt(values["per-area"]!, 10)
const seed = Number.parseInt(values.seed!, 10)
const sample = await samplePostcodes(csvDir, perArea, seed)
const register = await allPostcodes(csvDir)

console.log(`[gb-codepoint] existence oracle: ${register.size.toLocaleString()} unit postcodes`)

console.log(`[gb-codepoint] ${sample.length} postcodes sampled (${perArea}/area, seed ${seed}, stamp ${values.stamp})`)

const results: LegResult[] = []

for (const locale of ["en-US", "en-GB"]) {
	const session = await createGeocodeSession(createGeocodeCommandOptions({ locale }))

	for (const row of sample) {
		for (const { leg, input } of legsFor(row.postcode)) {
			const run = await session.geocode(input)
			const lat = run.result.lat
			const lon = run.result.lon
			const resolved = typeof lat === "number" && typeof lon === "number"

			results.push({
				postcode: row.postcode,
				area: row.area,
				leg,
				locale,
				resolved,
				km: resolved && leg !== "typo" ? haversineKm(row.lat, row.lon, lat, lon) : null,
			})
		}
	}

	session[Symbol.dispose]()

	console.log(`[gb-codepoint] ${locale}: ${sample.length * 3} runs complete`)
}

const outPath = values.out ?? dataRootPath("eval", `gb-codepoint-${values.stamp}-seed${seed}.jsonl`)

await writeLocalJSONLFile(results, outPath)

for (const locale of ["en-US", "en-GB"]) {
	console.log(`\n=== ${locale} ===`)
	console.log("leg              n     resolved  ≤1km   ≤5km   ≤25km  median-km")

	for (const leg of ["as_published", "lower_unspaced", "uk_suffixed"]) {
		const rows = results.filter((r) => r.locale === locale && r.leg === leg)
		const resolved = rows.filter((r) => r.resolved)

		const kms = resolved
			.map((r) => r.km!)
			// oxlint-disable-next-line unicorn/no-array-sort -- fresh array
			.sort((a, b) => a - b)

		const at = (t: number): string => `${rows.filter((r) => r.km !== null && r.km <= t).length}/${rows.length}`

		const median = kms.length ? kms[Math.floor(kms.length / 2)]!.toFixed(2) : "—"

		console.log(
			`${leg.padEnd(16)} ${String(rows.length).padStart(4)} ${String(resolved.length).padStart(8)}  ${at(THRESHOLDS_KM[0]).padEnd(6)} ${at(THRESHOLDS_KM[1]).padEnd(6)} ${at(THRESHOLDS_KM[2]).padEnd(6)} ${median}`
		)
	}

	const typo = results.filter((r) => r.locale === locale && r.leg === "typo")
	const phantom = typo.filter((r) => !register.has(mutateFinalLetter(r.postcode).replaceAll(" ", "").toUpperCase()))
	const real = typo.length - phantom.length
	const abstained = phantom.filter((r) => !r.resolved)

	console.log(
		`typo (phantom)   ${String(phantom.length).padStart(4)}  abstained ${abstained.length}/${phantom.length} — a resolved phantom is a failure; ${real} mutants exist in the register and are out of this leg's scope`
	)
}

console.log(`\n[gb-codepoint] results → ${outPath}`)
