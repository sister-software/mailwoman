/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Builds the street table from a source's road network: merged streets, the places that hold them, and the
 *   crossings where two streets share a node. A source supplies network edges and every step below reads only those,
 *   so one method serves every country. The build holds the network in memory, and one country's source fits.
 */

import { parseJSONStrict, stringifyJSON } from "@mailwoman/core/json"
import type { CandidateDatabase } from "@mailwoman/resolver-wof-sqlite/candidate/schema"
import { wofDatabasePath } from "@mailwoman/resolver-wof-sqlite/paths"
import type { PolygonDatabase } from "@mailwoman/resolver-wof-sqlite/polygon-schema"
import { normalizeStreetForKey } from "@mailwoman/resolver-wof-sqlite/street/normalize"
import { STREET_TABLE_DDL, type StreetTableDatabase } from "@mailwoman/resolver-wof-sqlite/street/table"
import { haversine } from "@mailwoman/spatial/geometries/point/distance"
import { geometryContains, type ParsedGeometry } from "@mailwoman/spatial/geometries/polygon"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { buildSealedArtifact } from "@mailwoman/sqlite/sealed/build"
import type { PathBuilderLike } from "path-ts"

/**
 * One road link from a source, already in latitude and longitude.
 */
export interface StreetNetworkEdge {
	name: string
	/**
	 * A second name the same road is read under, such as its name in a second language.
	 */
	alternateName?: string | null
	startNode: string
	endNode: string
	start: { lat: number; lon: number }
	middle: { lat: number; lon: number }
	end: { lat: number; lon: number }
	meters: number
}

export interface BuildStreetTableOptions {
	edges: AsyncIterable<StreetNetworkEdge>
	/**
	 * The upper-case country codes whose gazetteer places the rows tie to.
	 */
	countries: readonly string[]
	out: PathBuilderLike
	/**
	 * The gazetteer whose places hold the streets.
	 *
	 * @defaultValue `<data-root>/db/wof/candidate.db`
	 */
	candidatePath?: PathBuilderLike
	/**
	 * The boundary file.
	 *
	 * A place with a boundary holds what lies inside it, and any other place holds what
	 * lies inside its bounding box, because a box can reach far past the place itself.
	 */
	boundariesPath?: PathBuilderLike
	/**
	 * Called once a minute, and at the end of each stage.
	 */
	onProgress?: (counts: StreetTableCounts) => void
}

export interface StreetTableCounts {
	stage: "places" | "read" | "merge" | "streets" | "crossings" | "done"
	places: number
	placesWithBoundary: number
	edges: number
	skippedEdges: number
	streets: number
	streetsWithoutPlace: number
	streetPlaceRows: number
	crossingNodes: number
	crossings: number
	crossingPlaceRows: number
}

interface Place {
	id: number
	minLat: number
	maxLat: number
	minLon: number
	maxLon: number
	boundary: ParsedGeometry | null
}

interface Link {
	key: string
	alternateKey: string | null
	name: string
	lat: number
	lon: number
	meters: number
	start: number
	end: number
}

/**
 * Crossings of one pair of names within this distance are one location,
 * as a dual carriageway meets a road twice.
 */
const CROSSING_MERGE_METERS = 30

const PLACE_GRID_CELLS_PER_DEGREE = 10
const POINT_DECIMALS = 1e5
const PROGRESS_INTERVAL_MS = 60_000

const round = (value: number) => Math.round(value * POINT_DECIMALS) / POINT_DECIMALS

const gridCell = (value: number) => Math.floor(value * PLACE_GRID_CELLS_PER_DEGREE)

const boxArea = ({ minLat, maxLat, minLon, maxLon }: Place) => (maxLat - minLat) * (maxLon - minLon)

/**
 * Indexes the gazetteer's sub-country places in a coarse grid so a point reads
 * the places whose extents hold it.
 */
function readPlaceGrid(
	candidatePath: PathBuilderLike,
	boundariesPath: PathBuilderLike | undefined,
	countries: readonly string[],
	counts: StreetTableCounts
) {
	using db = new DatabaseClient<CandidateDatabase>(candidatePath, { readOnly: true })
	using boundaries = boundariesPath ? new DatabaseClient<PolygonDatabase>(boundariesPath, { readOnly: true }) : null
	const readBoundary = boundaries?.prepare("SELECT geom FROM polygons WHERE id = ?")
	const grid = new Map<string, Place[]>()
	const seen = new Set<number>()

	const rows = db
		.prepare(
			`SELECT c.spr_id AS id, c.min_lat AS minLat, c.max_lat AS maxLat, c.min_lon AS minLon, c.max_lon AS maxLon
			 FROM candidate c
			 JOIN placetype_codes t ON t.id = c.placetype_id
			 JOIN country_codes k ON k.id = c.country_id
			 WHERE k.code IN (${countries.map(() => "?").join(", ")}) AND c.is_primary = 1
			 AND t.placetype IN ('locality', 'localadmin', 'borough', 'macrohood', 'neighbourhood', 'microhood')
			 AND c.max_lat > c.min_lat`
		)
		.iterate(...countries) as Iterable<Omit<Place, "boundary">>

	for (const row of rows) {
		const id = Number(row.id)

		if (seen.has(id)) continue
		seen.add(id)

		counts.places++

		const stored = readBoundary?.get(id) as { geom: string } | undefined
		const place: Place = { ...row, id, boundary: stored ? parseJSONStrict<ParsedGeometry>(stored.geom) : null }

		if (stored) {
			counts.placesWithBoundary++
		}

		for (let lat = gridCell(row.minLat); lat <= gridCell(row.maxLat); lat++) {
			for (let lon = gridCell(row.minLon); lon <= gridCell(row.maxLon); lon++) {
				const cell = `${lat}:${lon}`
				const held = grid.get(cell)

				if (held) {
					held.push(place)
				} else {
					grid.set(cell, [place])
				}
			}
		}
	}

	// Boundaries leave gaps between towns, so a point inside no boundary belongs to the smallest box that holds it.
	return (lat: number, lon: number): Place[] => {
		const inBox = (grid.get(`${gridCell(lat)}:${gridCell(lon)}`) ?? []).filter(
			(place) => lat >= place.minLat && lat <= place.maxLat && lon >= place.minLon && lon <= place.maxLon
		)

		const inside = inBox.filter((place) => geometryContains(place.boundary, lon, lat) ?? true)

		if (inside.length || !inBox.length) return inside

		return inBox.toSorted((a, b) => boxArea(a) - boxArea(b)).slice(0, 1)
	}
}

/**
 * Returns the link nearest the mean position of the given links, the point that stands for them.
 */
function middleLink(links: readonly Link[]): Link {
	const lat = links.reduce((sum, link) => sum + link.lat, 0) / links.length
	const lon = links.reduce((sum, link) => sum + link.lon, 0) / links.length
	let best = links[0]!
	let bestDistance = Infinity

	for (const link of links) {
		const distance = (link.lat - lat) ** 2 + (link.lon - lon) ** 2

		if (distance < bestDistance) {
			bestDistance = distance
			best = link
		}
	}

	return best
}

/**
 * Joins links with one name that share a node, returning each merged street's links.
 */
function mergeStreets(links: readonly Link[]): Link[][] {
	const parents = links.map((_, index) => index)

	const find = (index: number): number => {
		let current = index

		while (parents[current] !== current) {
			parents[current] = parents[parents[current]!]!
			current = parents[current]!
		}

		return current
	}

	const seenAtNode = new Map<string, number>()

	links.forEach((link, index) => {
		for (const node of [link.start, link.end]) {
			const key = `${node}|${link.key}`
			const other = seenAtNode.get(key)

			if (typeof other === "number") {
				parents[find(index)] = find(other)
			} else {
				seenAtNode.set(key, index)
			}
		}
	})

	const streets = new Map<number, Link[]>()

	links.forEach((link, index) => {
		const root = find(index)
		const held = streets.get(root)

		if (held) {
			held.push(link)
		} else {
			streets.set(root, [link])
		}
	})

	return [...streets.values()]
}

/**
 * Builds the sealed street table and reports what it read.
 */
export async function buildStreetTable(options: BuildStreetTableOptions): Promise<StreetTableCounts> {
	const counts: StreetTableCounts = {
		stage: "places",
		places: 0,
		placesWithBoundary: 0,
		edges: 0,
		skippedEdges: 0,
		streets: 0,
		streetsWithoutPlace: 0,
		streetPlaceRows: 0,
		crossingNodes: 0,
		crossings: 0,
		crossingPlaceRows: 0,
	}

	const report = () => options.onProgress?.(counts)
	const timer = setInterval(report, PROGRESS_INTERVAL_MS)

	try {
		const placesAt = readPlaceGrid(
			options.candidatePath ?? wofDatabasePath("candidate.db"),
			options.boundariesPath,
			options.countries,
			counts
		)

		report()

		const nodeIDs = new Map<string, number>()
		const nodes: Array<{ lat: number; lon: number; keys: string[] }> = []
		const interned = new Map<string, string>()

		// A substring from the parser can hold its whole source chunk in memory.
		// A fresh copy of each distinct string releases the chunk, and one copy
		// serves every row that repeats it.
		const intern = (text: string): string => {
			const held = interned.get(text)

			if (typeof held === "string") return held

			const copy = Buffer.from(text).toString()

			interned.set(copy, copy)

			return copy
		}

		const nodeAt = (reference: string, position: { lat: number; lon: number }, key: string) => {
			let id = nodeIDs.get(reference)

			if (typeof id !== "number") {
				id = nodes.length
				nodeIDs.set(Buffer.from(reference).toString(), id)
				nodes.push({ lat: position.lat, lon: position.lon, keys: [] })
			}

			const { keys } = nodes[id]!

			if (!keys.includes(key)) {
				keys.push(key)
			}

			return id
		}

		counts.stage = "read"

		const links: Link[] = []

		for await (const edge of options.edges) {
			const key = intern(String(normalizeStreetForKey(edge.name)))

			if (!key) {
				counts.skippedEdges++

				continue
			}

			counts.edges++

			links.push({
				key,
				alternateKey: edge.alternateName ? intern(String(normalizeStreetForKey(edge.alternateName))) || null : null,
				name: intern(edge.name),
				lat: edge.middle.lat,
				lon: edge.middle.lon,
				meters: edge.meters,
				start: nodeAt(edge.startNode, edge.start, key),
				end: nodeAt(edge.endNode, edge.end, key),
			})
		}

		nodeIDs.clear()
		interned.clear()
		counts.stage = "merge"
		report()

		const streets = mergeStreets(links)

		return await buildSealedArtifact<StreetTableDatabase, StreetTableCounts, StreetTableCounts>({
			out: String(options.out),
			createTables: async (db) => {
				db.exec("PRAGMA page_size = 8192")
				db.exec(STREET_TABLE_DDL)
			},
			ingest: async (db) => {
				const insertStreet = db.prepare("INSERT INTO street VALUES (?, ?, ?, ?, ?, ?)")
				const insertName = db.prepare("INSERT INTO street_name VALUES (?, ?, ?, ?, ?, ?)")
				const insertPlace = db.prepare("INSERT OR IGNORE INTO street_place VALUES (?, ?, ?, ?, ?)")
				const insertCrossing = db.prepare("INSERT INTO street_crossing VALUES (?, ?, ?, ?, ?, ?)")
				const insertCrossingPlace = db.prepare("INSERT OR IGNORE INTO street_crossing_place VALUES (?, ?)")

				counts.stage = "streets"
				db.exec("BEGIN")

				for (const street of streets) {
					const id = ++counts.streets
					const first = street[0]!
					const center = middleLink(street)

					const bounds: [number, number, number, number] = [Infinity, -Infinity, Infinity, -Infinity]

					for (const { lat, lon } of street) {
						bounds[0] = Math.min(bounds[0], lat)
						bounds[1] = Math.max(bounds[1], lat)
						bounds[2] = Math.min(bounds[2], lon)
						bounds[3] = Math.max(bounds[3], lon)
					}

					insertStreet.run(
						id,
						first.name,
						center.lat,
						center.lon,
						street.reduce((sum, { meters }) => sum + meters, 0),
						stringifyJSON(street.flatMap(({ lat, lon }) => [round(lat), round(lon)]))
					)

					const keys = new Set(street.flatMap(({ key, alternateKey }) => (alternateKey ? [key, alternateKey] : [key])))

					for (const key of keys) {
						insertName.run(key, id, ...bounds)
					}

					const inPlace = new Map<number, Link[]>()

					for (const link of street) {
						for (const place of placesAt(link.lat, link.lon)) {
							const held = inPlace.get(place.id)

							if (held) {
								held.push(link)
							} else {
								inPlace.set(place.id, [link])
							}
						}
					}

					if (!inPlace.size) {
						counts.streetsWithoutPlace++
					}

					for (const [placeID, within] of inPlace) {
						const point = middleLink(within)

						for (const key of keys) {
							insertPlace.run(key, placeID, id, point.lat, point.lon)

							counts.streetPlaceRows++
						}
					}

					if (id % 100_000 === 0) {
						db.exec("COMMIT")
						db.exec("BEGIN")
					}
				}

				counts.stage = "crossings"
				report()

				const pairs = new Map<string, number[]>()

				nodes.forEach(({ keys }, node) => {
					if (keys.length < 2) return

					counts.crossingNodes++

					const sorted = keys.toSorted()

					for (let first = 0; first < sorted.length; first++) {
						for (let second = first + 1; second < sorted.length; second++) {
							const pair = `${sorted[first]}|${sorted[second]}`
							const held = pairs.get(pair)

							if (held) {
								held.push(node)
							} else {
								pairs.set(pair, [node])
							}
						}
					}
				})

				for (const [pair, pairNodes] of pairs) {
					const [a, b] = pair.split("|") as [string, string]
					const clusters: Array<{ lat: number; lon: number; nodes: number }> = []

					for (const node of pairNodes) {
						const { lat, lon } = nodes[node]!

						const near = clusters.find(
							(cluster) => haversine(cluster.lat, cluster.lon, lat, lon, "meters") <= CROSSING_MERGE_METERS
						)

						if (near) {
							near.lat = (near.lat * near.nodes + lat) / (near.nodes + 1)
							near.lon = (near.lon * near.nodes + lon) / (near.nodes + 1)

							near.nodes++
						} else {
							clusters.push({ lat, lon, nodes: 1 })
						}
					}

					for (const cluster of clusters) {
						const id = ++counts.crossings

						insertCrossing.run(a, b, id, cluster.lat, cluster.lon, cluster.nodes)

						for (const place of placesAt(cluster.lat, cluster.lon)) {
							insertCrossingPlace.run(id, place.id)

							counts.crossingPlaceRows++
						}
					}
				}

				db.exec("COMMIT")

				return counts
			},
			finish: async (_db, streamed) => {
				streamed.stage = "done"
				report()

				return streamed
			},
		})
	} finally {
		clearInterval(timer)
	}
}
