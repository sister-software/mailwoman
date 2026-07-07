/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   #619: convert the TX HHSC nursing-facilities source (which ships an authoritative `Geo Location`
 *   = `lat,lon` per facility) into the OaRow JSONL the resolver eval consumes — so our geocoder can
 *   be graded against the provided coordinates on real facility addresses (great-circle delta, tier
 *   breakdown via `oa-resolver-eval --address-points`).
 *
 *   Neutral scope: this measures GEOCODER ACCURACY on real public addresses; it makes no claim about
 *   the facilities themselves.
 *
 *   Run: node --experimental-strip-types registry/tools/txhhsc-to-oarow.ts\
 *   --src <tsv> --out /tmp/txhhsc-oarow.jsonl
 */

import { readFileSync, writeFileSync } from "node:fs"
import { parseArgs } from "node:util"

import { dataRootPath } from "@mailwoman/core/utils"

const { values } = parseArgs({
	options: {
		src: {
			type: "string",
			default: String(dataRootPath("record-matcher", "sources", "txhhsc_nursing-facilities_20260611.tsv")),
		},
		out: { type: "string", default: "/tmp/txhhsc-oarow.jsonl" },
	},
})
const src = values.src!
const out = values.out!

const lines = readFileSync(src, "utf8")
	.split("\n")
	.filter((l) => l.trim())
const header = lines[0]!.split("\t")
const col = (name: string) => header.indexOf(name)
const cAddr = col("Physical Address")
const cCity = col("Physical Address CITY")
const cState = col("Physical Address State")
const cZip = col("Physical Address Zipcode")
const cGeo = col("Geo Location")

const GEO = /^\s*(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)\s*$/

const records: string[] = []
let skipped = 0

for (const line of lines.slice(1)) {
	const f = line.split("\t")
	const addr = (f[cAddr] ?? "").trim()
	const city = (f[cCity] ?? "").trim()
	const zip = (f[cZip] ?? "").trim()
	const m = GEO.exec(f[cGeo] ?? "")

	if (!addr || !city || !m) {
		skipped++
		continue
	}
	const lat = Number(m[1])
	const lon = Number(m[2])

	// Sanity: TX bounding box (rejects swapped/garbage coords).
	if (lat < 25 || lat > 37 || lon > -93 || lon < -107) {
		skipped++
		continue
	}
	records.push(
		JSON.stringify({
			input: `${addr}, ${city}, TX ${zip}`,
			lat,
			lon,
			expected: { locality: city, region: "TX", postcode: zip },
			state: "TX",
			source: "txhhsc:nursing-facilities",
		})
	)
}

writeFileSync(out, records.join("\n") + "\n")
console.error(`wrote ${records.length} rows (skipped ${skipped}) → ${out}`)
