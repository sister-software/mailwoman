/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   CJK nearest-point resolution + name-agreement metric (#292, Direction E).
 *
 *   WOF CJK admin geometry is POINT-based at the municipality/locality level (confirmed JP+KR+TW), so
 *   the European PIP-into-polygons method is inapplicable. This is the CJK substitute: assign each
 *   postcode to the NEAREST WOF place (point), and measure with a NAME-AGREEMENT metric (not
 *   PIP-containment) — does the resolved WOF place's name agree with the postcode's independent
 *   municipality name?
 *
 *   Gold source: GeoNames postal (postcode -> placename/admin2 name + point). NON-CIRCULAR caveat:
 *   the point drives the nearest-assignment and the NAME validates it, but when gold == GeoNames
 *   for both, the metric chiefly measures cross-source NAME agreement — and it is confounded by WOF
 *   JP's inconsistent admin modeling. The authoritative fix is KEN_ALL (postcode->romanized
 *   municipality, matches WOF romaji) — published but Japan Post blocks programmatic download.
 *   Until KEN_ALL lands, this metric UNDERCOUNTS true resolution accuracy; treat the number as a
 *   floor.
 *
 *   Usage: node --experimental-strip-types scripts/eval/cjk-nearest-name-agreement.ts\
 *   --geonames /mnt/playpen/mailwoman-data/geonames/JP.txt --country JP\
 *   --admin-db /mnt/playpen/mailwoman-data/wof/admin-global-priority.db --placetype county --sample
 *   3000
 *
 *   Ported faithfully from scripts/eval/cjk-nearest-name-agreement.py. NOTE: (1) the seeded RNG
 *   sample is distribution-faithful but NOT CPython-bit-identical (see python-random.ts); (2)
 *   Python's `unicodedata.combining(c) != 0` is approximated by stripping Unicode nonspacing marks
 *   (`\p{Mn}`) after NFKD — exact for the romaji/Latin path this metric runs on.
 */

import { readFileSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import { parseArgs } from "node:util"

import { SeededRandom } from "../lib/python-random.ts"

const SUFFIXES = /(shi|ku|cho|machi|ward|gun|ken|fu|to|son|mura|si|gun|do|gu|dong|eup|myeon|ri)$/

function norm(s: string): string {
	let out = s.normalize("NFKD")
	out = [...out]
		.filter((c) => !/\p{Mn}/u.test(c))
		.join("")
		.toLowerCase()
	out = out.replace(/[\s-]/g, "")

	return out.replace(SUFFIXES, "")
}

function agree(a: string, b: string): boolean {
	const na = norm(a)
	const nb = norm(b)

	return Boolean(na && nb && (na === nb || nb.includes(na) || na.includes(nb)))
}

const radians = (x: number): number => (x * Math.PI) / 180

function haversine(a: number, b: number, c: number, d: number): number {
	const R = 6371.0
	const p1 = radians(a)
	const p2 = radians(c)
	const dp = radians(c - a)
	const dl = radians(d - b)

	return 2 * R * Math.asin(Math.sqrt(Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2))
}

/** Python `round()` — round half to even (banker's rounding). */
function pyRound(x: number): number {
	const f = Math.floor(x)
	const diff = x - f

	if (diff < 0.5) return f

	if (diff > 0.5) return f + 1

	return f % 2 === 0 ? f : f + 1
}

type Pt = [string, number, number] // (name, lat, lon)

function main(): void {
	const { values } = parseArgs({
		options: {
			geonames: { type: "string" },
			country: { type: "string" },
			"admin-db": { type: "string" },
			placetype: { type: "string", default: "county" },
			sample: { type: "string", default: "3000" },
			seed: { type: "string", default: "7" },
		},
	})

	for (const req of ["geonames", "country", "admin-db"] as const) {
		if (!values[req]) {
			process.stderr.write(`error: the following arguments are required: --${req}\n`)
			process.exit(2)
		}
	}
	const country = values.country!
	const placetype = values.placetype!
	const sampleN = Number(values.sample)

	const db = new DatabaseSync(values["admin-db"]!, { readOnly: true })
	const pts = db
		.prepare("SELECT name, latitude, longitude FROM spr WHERE country=? AND placetype=? AND latitude IS NOT NULL")
		.all(country, placetype) as Array<{ name: string; latitude: number; longitude: number }>
	// 0.5deg grid for nearest-neighbour
	const grid = new Map<string, Pt[]>()

	for (const { name: nm, latitude: la, longitude: lo } of pts) {
		const key = `${pyRound(lo * 2)},${pyRound(la * 2)}`
		let cell = grid.get(key)

		if (!cell) {
			cell = []
			grid.set(key, cell)
		}
		cell.push([nm, la, lo])
	}

	function nearest(lat: number, lon: number): [string | null, number] {
		let best: string | null = null
		let bd = 1e9
		const cx = pyRound(lon * 2)
		const cy = pyRound(lat * 2)

		for (let r = 0; r < 6; r++) {
			for (let dx = -r; dx <= r; dx++) {
				for (let dy = -r; dy <= r; dy++) {
					if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue

					for (const [nm, la, lo] of grid.get(`${cx + dx},${cy + dy}`) ?? []) {
						const dd = haversine(lat, lon, la, lo)

						if (dd < bd) {
							bd = dd
							best = nm
						}
					}
				}
			}

			if (best && r >= 1) break
		}

		return [best, bd]
	}

	const gold: Array<[string, string, number, number]> = []

	for (const line of readFileSync(values.geonames!, "utf-8").split("\n")) {
		const f = line.split("\t")

		if (f.length > 10 && f[5]) {
			const lat = Number(f[9])
			const lon = Number(f[10])

			if (Number.isNaN(lat) || Number.isNaN(lon)) continue // Python float() ValueError -> pass
			gold.push([f[2]!, f[5]!, lat, lon]) // town, municipality, lat, lon
		}
	}
	const rng = new SeededRandom(Number(values.seed))
	const sample = rng.sample(gold, Math.min(sampleN, gold.length))

	let agreeMuni = 0
	let agreeAny = 0
	const dists: number[] = []

	for (const [town, muni, lat, lon] of sample) {
		const [nm, d] = nearest(lat, lon)

		if (nm === null) continue
		dists.push(d)
		const am = agree(nm, muni)

		if (am) {
			agreeMuni += 1
		}

		if (am || agree(nm, town)) {
			agreeAny += 1
		}
	}
	const n = sample.length
	const sortedDists = dists.slice().sort((a, b) => a - b)
	const md = dists.length ? sortedDists[Math.floor(dists.length / 2)]! : 0
	console.log(
		`${country} @ WOF ${placetype}: name-agree(muni)=${((100 * agreeMuni) / n).toFixed(1)}%  ` +
			`agree(muni|town)=${((100 * agreeAny) / n).toFixed(1)}%  median nearest dist=${md.toFixed(1)}km  (n=${n})`
	)
}

main()
