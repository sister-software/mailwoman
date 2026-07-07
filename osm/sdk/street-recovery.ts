/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   #250 street recovery — recover the street for an OSM `addr:housenumber` point that carries no
 *   `addr:street` (58% of IDF points; they're not `addr:place` hamlets, they're street addresses missing
 *   the tag). The recovery is a nearest-named-highway spatial join: assign the name of the closest named
 *   highway within a tight radius. A grid index over densified highway vertices keeps it O(points).
 *
 *   ⚠ A wrong recovery can create a false-positive rooftop (a point keyed under the wrong street), so the
 *   radius is tight and the whole thing is gated on the held-out Gauntlet (does FR coverage rise WITHOUT
 *   accuracy falling). Validate accuracy on the points that DO have `addr:street` (ground truth) first.
 */

import { spawn } from "node:child_process"
import { createInterface } from "node:readline"

import { haversineKm } from "@mailwoman/spatial"

const CELL_DEG = 0.003 // ~330m grid cell
const DENSIFY_KM = 0.02 // interpolate a vertex every ~20m along each segment

interface Vertex {
	name: string
	lon: number
	lat: number
}

/** Grid-indexed nearest-named-highway lookup. */
export class StreetRecoveryIndex {
	readonly #grid = new Map<string, Vertex[]>()
	#count = 0

	get size(): number {
		return this.#count
	}

	#key(lon: number, lat: number): string {
		return `${Math.floor(lon / CELL_DEG)}:${Math.floor(lat / CELL_DEG)}`
	}

	add(name: string, lon: number, lat: number): void {
		const k = this.#key(lon, lat)
		let cell = this.#grid.get(k)

		if (!cell) {
			cell = []
			this.#grid.set(k, cell)
		}
		cell.push({ name, lon, lat })
		this.#count++
	}

	/** Nearest highway name within `maxKm`, or null. Scans the point's cell + the 8 neighbours. */
	nearest(lon: number, lat: number, maxKm: number): { name: string; km: number } | null {
		const cx = Math.floor(lon / CELL_DEG)
		const cy = Math.floor(lat / CELL_DEG)
		let best: { name: string; km: number } | null = null

		for (let dx = -1; dx <= 1; dx++) {
			for (let dy = -1; dy <= 1; dy++) {
				const cell = this.#grid.get(`${cx + dx}:${cy + dy}`)

				if (!cell) continue

				for (const v of cell) {
					const km = haversineKm(lat, lon, v.lat, v.lon)

					if (km <= maxKm && (!best || km < best.km)) {
						best = { name: v.name, km }
					}
				}
			}
		}

		return best
	}
}

/**
 * Densify a LineString: yield its vertices plus interpolated points every ~DENSIFY_KM so a mid-segment address still
 * finds the street.
 */
function* densify(coords: number[][]): Generator<[number, number]> {
	for (let i = 0; i < coords.length; i++) {
		const [lon, lat] = coords[i] as [number, number]
		yield [lon, lat]

		if (i + 1 < coords.length) {
			const [lon2, lat2] = coords[i + 1] as [number, number]
			const km = haversineKm(lat, lon, lat2, lon2)
			const steps = Math.floor(km / DENSIFY_KM)

			for (let s = 1; s < steps; s++) {
				const t = s / steps
				yield [lon + (lon2 - lon) * t, lat + (lat2 - lat) * t]
			}
		}
	}
}

/** Build the recovery index from the PBF's named highways (the `lines` layer). */
export async function buildStreetRecoveryIndex(pbfPath: string): Promise<StreetRecoveryIndex> {
	const args = [
		"-f",
		"GeoJSONSeq",
		"/vsistdout/",
		"-dialect",
		"OGRSQL",
		"-sql",
		"SELECT name FROM lines WHERE highway IS NOT NULL AND name IS NOT NULL",
		pbfPath,
	]
	const proc = spawn("ogr2ogr", args, { stdio: ["ignore", "pipe", "pipe"] })
	let stderr = ""

	proc.stderr.on("data", (d: Buffer) => {
		stderr += d.toString()
	})
	const exit = new Promise<number>((resolve, reject) => {
		proc.on("error", reject)
		proc.on("close", resolve)
	})
	const index = new StreetRecoveryIndex()
	const rl = createInterface({ input: proc.stdout!, crlfDelay: Infinity })

	for await (const raw of rl) {
		const line = raw.replace(/^/, "").trim()

		if (!line) continue
		let f: { properties?: { name?: string }; geometry?: { type?: string; coordinates?: number[][] } }

		try {
			f = JSON.parse(line)
		} catch {
			continue
		}
		const name = f.properties?.name

		if (!name || f.geometry?.type !== "LineString" || !Array.isArray(f.geometry.coordinates)) continue

		for (const [lon, lat] of densify(f.geometry.coordinates)) {
			index.add(name, lon, lat)
		}
	}
	const code = await exit

	if (code !== 0) throw new Error(`ogr2ogr (highways) exited ${code}: ${stderr.slice(-400)}`)

	return index
}
