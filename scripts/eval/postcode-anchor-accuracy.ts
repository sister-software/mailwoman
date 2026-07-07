/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Gazetteer-quality eval for the postcode anchor (#240): how close does the anchor's centroid land
 *   to the true address? For each OpenAddresses point with a postcode and real coordinates, look
 *   the postcode up in the shards, take the centroid for that country, and measure the haversine
 *   distance to the true point.
 *
 *   This measures the parent-borrow backfill, not rooftop accuracy. A backfilled centroid is the
 *   parent LOCALITY's centre, so the expected distance is "how far is this address from the middle
 *   of its town" — a few km in a city, more in a large rural postcode. That is exactly the
 *   resolution a "which city/region" anchor needs; the eval just confirms the borrow lands in the
 *   right town.
 *
 *   Run: node --experimental-strip-types scripts/eval/postcode-anchor-accuracy.ts\
 *   --eval data/eval/external/openaddresses-de-sample.jsonl --country DE
 */

import { readFileSync } from "node:fs"

import { dataRootPath } from "@mailwoman/core/utils"
import { haversineKm, WOFPostcodeLookup } from "@mailwoman/resolver-wof-sqlite"

interface Args {
	evalPath: string
	country: string
	shards: string[]
}

function parseArgs(): Args {
	const args = process.argv.slice(2)
	let evalPath = "data/eval/external/openaddresses-de-sample.jsonl"
	let country = "DE"
	const shards = [dataRootPath("wof", "postalcode-us.db"), dataRootPath("wof", "postalcode-intl.db")]

	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--eval" && args[i + 1]) {
			evalPath = args[++i]!
		} else if (args[i] === "--country" && args[i + 1]) {
			country = args[++i]!
		} else if (args[i] === "--shard" && args[i + 1]) {
			shards.push(args[++i]!)
		}
	}

	return { evalPath, country, shards }
}

function pct(sorted: number[], p: number): number {
	if (sorted.length === 0) return NaN
	const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))

	return sorted[i]!
}

function main(): void {
	const { evalPath, country, shards } = parseArgs()
	const lookup = new WOFPostcodeLookup(shards)

	const lines = readFileSync(evalPath, "utf8").split("\n").filter(Boolean)
	let withPostcode = 0
	let placed = 0
	let inGazetteerNoCentroid = 0
	let notInGazetteer = 0
	const distances: number[] = []

	for (const line of lines) {
		const row = JSON.parse(line)
		const postcode: string | undefined = row.expected?.postcode ?? row.postcode ?? row.components?.postcode
		const lat: number | undefined = row.lat
		const lon: number | undefined = row.lon

		if (!postcode || typeof lat !== "number" || typeof lon !== "number") continue
		withPostcode++

		const hits = lookup.lookup(String(postcode)).filter((h) => h.country === country)

		if (hits.length === 0) {
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

	lookup.close()
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
		`  p50 ${pct(distances, 50).toFixed(1)}  p90 ${pct(distances, 90).toFixed(1)}  p99 ${pct(distances, 99).toFixed(1)}  max ${(distances[distances.length - 1] ?? NaN).toFixed(1)}`
	)
	const within10 = distances.filter((d) => d <= 10).length
	const within25 = distances.filter((d) => d <= 25).length
	console.log(
		`  within 10km: ${((100 * within10) / placed).toFixed(1)}%   within 25km: ${((100 * within25) / placed).toFixed(1)}%`
	)
}

main()
