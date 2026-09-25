/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { percentile } from "@mailwoman/core/stats"
import { WOFPostcodeLookup } from "@mailwoman/resolver-wof-sqlite"
import { wofDatabasePath } from "@mailwoman/resolver-wof-sqlite/paths"
import { haversineKm } from "@mailwoman/spatial"
import { resolvePath } from "path-ts"
import { JSONSpliterator } from "spliterator"

const ANCHOR_TOLERANCE_KM = 25

interface Args {
	evalPath: string
	country: string
	databases: string[]
}

function parseArgs(): Args {
	let evalPath = "data/eval/external/openaddresses-de-sample.jsonl"
	let country = "DE"

	const databases: string[] = [
		resolvePath(wofDatabasePath("postalcode-us.db")),
		resolvePath(wofDatabasePath("postalcode-intl.db")),
	]

	const { values } = parseArguments({
		options: { country: { type: "string" }, eval: { type: "string" }, extract: { type: "string", multiple: true } },
		allowPositionals: true,
	})

	if (values.eval !== undefined) {
		evalPath = values.eval
	}

	if (values.country !== undefined) {
		country = values.country
	}

	databases.push(...(values.extract ?? []))

	return { evalPath, country, databases }
}

interface EvalRow {
	expected?: { postcode?: string; lat?: number; lon?: number }
	postcode?: string
	components?: { postcode?: string }
	lat?: number
	lon?: number
}

async function main(): Promise<void> {
	const { evalPath, country, databases } = parseArgs()
	using lookup = new WOFPostcodeLookup(databases)

	const rows = JSONSpliterator.fromAsync<EvalRow>(evalPath)
	let withPostcode = 0
	let placed = 0
	let inGazetteerNoCentroid = 0
	let notInGazetteer = 0
	const distances: number[] = []

	for await (const row of rows) {
		const postcode: string | undefined = row.expected?.postcode ?? row.postcode ?? row.components?.postcode
		const lat: number | undefined = row.lat
		const lon: number | undefined = row.lon

		if (!postcode || typeof lat !== "number" || typeof lon !== "number") continue

		withPostcode++

		const hits = lookup.lookup(String(postcode)).filter((h) => h.country === country)

		if (!hits.length) {
			notInGazetteer++

			continue
		}

		const placedHit = hits.find((h) => h.lat !== 0 && h.lon !== 0)

		if (!placedHit) {
			inGazetteerNoCentroid++

			continue
		}

		placed++
		distances.push(haversineKm(lat, lon, placedHit.lat, placedHit.lon))
	}

	distances.sort((a, b) => a - b)

	console.log(`# Postcode-anchor centroid accuracy — ${country}`)
	console.log(`eval: ${evalPath}`)
	console.log(`rows with postcode + coords: ${withPostcode}`)
	console.log(`  placed (centroid found):     ${placed} (${((100 * placed) / withPostcode).toFixed(1)}%)`)
	console.log(
		`  in gazetteer, no centroid:   ${inGazetteerNoCentroid} (${((100 * inGazetteerNoCentroid) / withPostcode).toFixed(1)}%)`
	)
	console.log(
		`  not in gazetteer at all:     ${notInGazetteer} (${((100 * notInGazetteer) / withPostcode).toFixed(1)}%)`
	)
	console.log(`distance to true address (placed only), km:`)
	console.log(
		`  p50 ${(percentile(distances, 50) ?? Number.NaN).toFixed(1)}  p90 ${(percentile(distances, 90) ?? Number.NaN).toFixed(1)}  p99 ${(percentile(distances, 99) ?? Number.NaN).toFixed(1)}  max ${(distances.at(-1) ?? Number.NaN).toFixed(1)}`
	)

	const within10 = distances.filter((d) => d <= 10).length
	const within25 = distances.filter((d) => d <= ANCHOR_TOLERANCE_KM).length

	console.log(
		`  within 10km: ${((100 * within10) / placed).toFixed(1)}%   within 25km: ${((100 * within25) / placed).toFixed(1)}%`
	)
}

await main()
