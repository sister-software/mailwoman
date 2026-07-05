/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Build a coordinate-eval golden from an OSM `.osm.pbf` extract — the #937 path for countries with
 *   no OpenAddresses country extract (GB/IE/HU). Streams `addr:*` points via {@link extractAddrPoints}
 *   (the same GDAL reader the rooftop shards use — salvage, not new infra), reservoir-samples per
 *   postcode-prefix bucket for geographic diversity, and writes the same golden schema
 *   `build-oa-coord-golden` does: `{ raw, components:{house_number,street,postcode,locality}, country,
 *   lat, lon, source }`. Truth coords are the OSM node/building coordinate.
 *
 *   Address ORDER is number-first (`10 Downing Street, London SW1A 2AA`) — the GB/IE/HU natural order,
 *   NOT the EU street-first order the OA builder renders. Share-alike (ODbL) OSM data is fine for an
 *   EVAL artifact that never enters trained weights — same reasoning as the OSM rooftop tier.
 *
 *   Run: node scripts/eval/build-osm-coord-golden.ts --country GB \
 *     --pbf $MAILWOMAN_DATA_ROOT/osm/geofabrik/great-britain-latest.osm.pbf \
 *     --out data/eval/external/oa-gb-coord-1k.jsonl --n 1000
 */

import { mkdirSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { parseArgs } from "node:util"

import { extractAddrPoints } from "../../osm/sdk/extract.ts"
import { pyJsonDumps } from "../lib/python-json.ts"
import { SeededRandom } from "../lib/python-random.ts"

/** GB/IE/HU natural order is number-first; three diversity variants keep the parser from overfitting one template. */
const ORDERS = ["canonical", "no-comma", "pc-line"] as const

function render(num: string, street: string, cp: string, city: string, order: (typeof ORDERS)[number]): string {
	if (order === "canonical") return `${num} ${street}, ${city} ${cp}`
	if (order === "no-comma") return `${num} ${street} ${city} ${cp}`

	return `${num} ${street}, ${city}, ${cp}`
}

interface Sampled {
	num: string
	street: string
	cp: string
	city: string
	lat: number
	lon: number
}

async function main(): Promise<void> {
	const { values } = parseArgs({
		options: {
			country: { type: "string" },
			pbf: { type: "string" },
			out: { type: "string" },
			n: { type: "string", default: "1000" },
			"per-bucket": { type: "string", default: "60" },
			seed: { type: "string", default: "42" },
			// Optional postcode-format filter (an anchored regex). Needed when a PBF extract spans postal
			// systems — e.g. ireland-and-northern-ireland: NI rows carry GB `BT…` codes that would pollute
			// an IE panel; pass the Eircode pattern to keep IE rows only.
			"postcode-re": { type: "string" },
		},
	})

	for (const req of ["country", "pbf", "out"] as const) {
		if (!values[req]) {
			process.stderr.write(`error: required: --${req}\n`)
			process.exit(2)
		}
	}
	const country = values.country!.toUpperCase()
	const n = Number(values.n)
	const perBucket = Number(values["per-bucket"])
	const postcodeRe = values["postcode-re"] ? new RegExp(values["postcode-re"], "i") : null
	const rng = new SeededRandom(Number(values.seed))
	const buckets = new Map<string, Sampled[]>()
	const bucketSeen = new Map<string, number>()

	let kept = 0
	let scanned = 0

	for await (const rec of extractAddrPoints(values.pbf!)) {
		scanned += 1
		const num = (rec.housenumber ?? "").trim()
		const street = (rec.street ?? "").trim()
		const city = (rec.city ?? "").trim()
		const cp = (rec.postcode ?? "").trim()

		// A resolvable golden row needs house number + street + city + postcode + a coordinate, and a
		// street that starts with a letter (drops the odd "-" / numeric-only tag).
		if (!(num && street && city && cp && num !== "0" && /^\p{L}/u.test(street))) continue
		if (!Number.isFinite(rec.lat) || !Number.isFinite(rec.lon)) continue
		if (postcodeRe && !postcodeRe.test(cp)) continue

		// Geographic diversity: the outward-code prefix (GB "SW"/"EC", HU 2-digit) buckets the reservoir.
		const key = cp.slice(0, 2).toUpperCase()
		let bucket = buckets.get(key)

		if (!bucket) {
			bucket = []
			buckets.set(key, bucket)
		}
		// Algorithm R per bucket — every valid row in the stream gets an equal chance of a slot.
		const seen = (bucketSeen.get(key) ?? 0) + 1
		bucketSeen.set(key, seen)

		if (bucket.length < perBucket) {
			bucket.push({ num, street, cp, city, lat: rec.lat, lon: rec.lon })
			kept += 1
		} else {
			const j = rng.randint(0, seen - 1)

			if (j < perBucket) bucket[j] = { num, street, cp, city, lat: rec.lat, lon: rec.lon }
		}
	}

	const rows: Record<string, unknown>[] = []
	let i = 0

	for (const key of [...buckets.keys()].sort()) {
		for (const r of buckets.get(key)!) {
			const order = ORDERS[i % ORDERS.length]!
			i += 1
			rows.push({
				raw: render(r.num, r.street, r.cp, r.city, order),
				components: { house_number: r.num, street: r.street, postcode: r.cp, locality: r.city },
				country,
				lat: r.lat,
				lon: r.lon,
				source: `osm-${country.toLowerCase()}`,
			})
		}
	}
	rng.shuffle(rows)
	const trimmed = rows.slice(0, n)

	mkdirSync(dirname(values.out!), { recursive: true })
	writeFileSync(values.out!, trimmed.map((r) => pyJsonDumps(r, { ensureAscii: false }) + "\n").join(""))
	process.stderr.write(
		`wrote ${trimmed.length} ${country} rows across ${buckets.size} buckets (scanned ${scanned} OSM addr points, kept ${kept}) -> ${values.out}\n`
	)
}

await main()
