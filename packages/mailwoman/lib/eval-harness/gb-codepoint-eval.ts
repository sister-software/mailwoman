/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   GB postcode-resolution evaluation against OS Code-Point Open — the first UK accuracy measurement this project can
 *   run without licensed data, and the measurement's own limits stated up front:
 *
 *   1. **The truth and the gazetteer share a source.** Our GB postcode tier is built FROM Code-Point Open
 *      (`codepoint-database.ts`), so grading against Code-Point centroids does not measure independent coordinate
 *      accuracy. What it DOES measure is the pipeline end-to-end: does a messy, real-shaped postcode string come back
 *      as the right unit-postcode point through parse → retrieval → resolution? That is the engine's claim; the
 *      data's accuracy is Ordnance Survey's.
 *   2. **The coordinate conversion cancels.** Truth is converted OSGB36 → WGS84 by the same `@mailwoman/spatial`
 *      routine the database build uses, so a systematic conversion bias would be invisible here. The conversion is
 *      pinned against the OSTN15 test set in its own suite; this eval adds nothing to that claim.
 *   3. **Premise-level accuracy is out of reach.** A unit postcode is tens of houses; there is no open GB register
 *      to grade a rooftop answer against. The distance thresholds below are therefore postcode-scale (≤1 km) rather
 *      than rooftop-scale.
 *
 *   Sample: a seeded, stratified draw across every Code-Point area file (every area contributes equally, so London
 *   does not drown Orkney). Rows with positional-quality 90 (no coordinate available) are skipped, matching the
 *   database build. Each sampled postcode runs THREE input legs — as published ("SW10 0AA"), lowercased and unspaced
 *   ("sw100aa", the user register), and country-suffixed ("SW10 0AA, UK") — under TWO locales: the production
 *   default and en-GB.
 *
 *   Contains OS data © Crown copyright and database right 2026 (Code-Point Open, OGL v3).
 *
 *   Run: node packages/mailwoman/lib/eval-harness/gb-codepoint-eval.ts [--stamp 2026-08-05] [--per-area 5] [--out <jsonl>]
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { readDirectory, readLocalTextFile } from "@mailwoman/core/fs/readers"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { mulberry32 } from "@mailwoman/core/random"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { haversineKm, osgb36ToWGS84 } from "@mailwoman/spatial"
import { basename, join } from "path-ts"

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
 * Positional-quality value meaning "no coordinate available" — dropped, matching `codepoint-database.ts`.
 */
const PQ_NO_COORDINATE = 90

/**
 * Every postcode in the acquisition, folded to unspaced-uppercase — the existence oracle for the typo leg. A mutated
 * final letter frequently lands on a REAL neighbouring unit ("AB55 4BD" → "AB55 4BE"), and resolving those is correct
 * behavior; only a mutant absent from the register demands abstention. Reasoning "the mutant almost never exists" was
 * measured wrong on the first run (346/600 resolved), which is why this set exists.
 */
async function allPostcodes(csvDir: string): Promise<Set<string>> {
	const out = new Set<string>()

	for (const file of (await readDirectory(csvDir)).filter((f) => f.endsWith(".csv"))) {
		// oxlint-disable-next-line mailwoman/prefer-spliterator -- bounded input, one pass
		for (const line of (await readLocalTextFile(join(csvDir, file))).split("\n")) {
			const pc = line.split(",")[0]?.replaceAll('"', "").trim()

			if (pc) {
				out.add(pc.replaceAll(" ", "").toUpperCase())
			}
		}
	}

	return out
}

async function samplePostcodes(csvDir: string, perArea: number, seed: number): Promise<SampledPostcode[]> {
	const random = mulberry32(seed)
	const out: SampledPostcode[] = []

	for (const file of (await readDirectory(csvDir)).filter((f) => f.endsWith(".csv")).toSorted()) {
		const rows: SampledPostcode[] = []

		// Code-Point area files are small (the largest ~90k rows); whole-file split is bounded here.
		// oxlint-disable-next-line mailwoman/prefer-spliterator -- bounded input, one pass
		for (const line of (await readLocalTextFile(join(csvDir, file))).split("\n")) {
			if (!line) continue
			// Columns: PC,PQ,EA,NO,… — quoted postcode, then numerics. Code-Point carries no embedded
			// commas inside quotes, so a plain split is faithful to this source.
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

		// Seeded draw without replacement — deterministic across runs for a given stamp + seed.
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
		// The leg that CAN fail, with the pass condition depending on whether the mutant EXISTS: a real
		// neighbouring unit must resolve like any postcode; a mutant absent from the register demands
		// ABSTENTION — a "corrected" postcode is a DIFFERENT postcode (the BT3 9QQ → S3 9QQ trap class).
		{ leg: "typo", input: mutateFinalLetter(postcode) },
	]
}

/**
 * Deterministically swap the final letter for its alphabet successor (Z→A), skipping letters GB unit postcodes never
 * use in final position (C, I, K, M, O, V are excluded from the alphabet there — stepping INTO one guarantees the
 * mutant is invalid, which is fine; the pass condition is abstention either way).
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

const csvDir = String(dataRootPath("codepoint", values.stamp!, "Data", "CSV"))
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

const outPath = values.out ?? String(dataRootPath("eval", `gb-codepoint-${values.stamp}-seed${seed}.jsonl`))

await writeLocalTextFile(results.map((r) => JSON.stringify(r)).join("\n") + "\n", outPath)

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
