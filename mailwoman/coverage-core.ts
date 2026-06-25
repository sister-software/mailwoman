/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Builder for the demo map's "fog of war" address-COVERAGE overlay — an H3 hexbin tileset that
 *   shades each area by how much address-point data we hold (covered → clear, empty → gray fog).
 *   Backs the `mailwoman coverage build` command; kept React-free here so the logic is testable and
 *   the command is a thin Ink wrapper (mirrors `geocode-core.ts`).
 *
 *   Pipeline: ATTACH the per-state address-point shards (+ interpolation shards) read-only → DuckDB's
 *   H3 community extension bins points to a fine resolution and rolls up to coarser ones →
 *   boundaries stream to NDJSON → `tippecanoe` bakes one `coverage` source-layer into a single
 *   PMTiles. Publish the result with `mailwoman tiles publish`.
 *
 *   FOG MODEL — each cell carries TWO baked values in [0,1] (0 = covered/clear, 1 = empty/gray): •
 *   fine cell: fog = 1 − blended coverage score (address-point density, plus a weaker
 *   street-segment interpolation signal so a street-only cell reads as partial coverage, never a
 *   full gap). • coarse cell: fog = 1 − the MEAN child coverage — "on average, how covered are the
 *   blocks here" — so a region reads clear when zoomed out and the specific gaps surface as you
 *   zoom into the fine res. • `fog_opt = fog ** OPTIMISTIC_GAMMA` (γ>1) lifts partial coverage
 *   toward clear for an optimistic "looks covered until you zoom in" reading; the demo toggles
 *   between `fog` and `fog_opt`.
 *
 *   Each resolution is baked in its own non-overlapping zoom band (per-feature tippecanoe
 *   minzoom/maxzoom); the finest is baked at a single tile-max level and MapLibre overzooms above
 *   it (hexes are identical geometry at every zoom), so we don't duplicate millions of hexes across
 *   z13–22.
 *
 *   DuckDB is a dynamic import (dev/maintainer-only dep) so the published CLI doesn't force a heavy
 *   native dependency on end users who only ever run parse/geocode.
 */

import { createWriteStream, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs"
import * as path from "node:path"
import { $ } from "zx"

export interface CoverageBuildOptions {
	/** Comma-separated state slugs (e.g. "CA,TX") or "all" to glob the data root. */
	states: string
	/** State slugs to exclude (e.g. ["AK"] — antimeridian hex-wrap). */
	excludeStates: string[]
	/** Root holding `address-points-us-<st>.db` shards. */
	dataRoot: string
	/** Root holding `interpolation-us-<st>.db` shards, or null to skip the street-segment signal. */
	interpRoot: string | null
	/** Finest H3 resolution (the fog floor). 9 ≈ 174 m (street/block). */
	fineRes: number
	/** Coarser resolutions for lower zoom bands, finest-excluded (e.g. [7, 5]). */
	rollup: number[]
	/** Parent resolution whose data-bearing cells define the fog neighborhood (6 ≈ 3.2 km). */
	domainRes: number
	/** Address-point count at/above which a fine cell fully clears. */
	saturation: number
	/** Street-segment count at/above which the interpolation signal saturates. */
	satSeg: number
	/** Weight (<1) of the street-segment signal relative to address points. */
	interpWeight: number
	/** Optimistic-mode exponent for `fog_opt = fog ** gamma`. */
	optimisticGamma: number
	/**
	 * GeoNames postal file (12-col tab-separated) — the GLOBAL postcode COVERAGE signal that clears
	 * the "where do we need data" holes. Null to skip. A postcode is area-scale, so centroids bin at
	 * the domain resolution and a domain cell holding ≥1 postcode reads as postcode-resolvable
	 * (covered).
	 */
	geonamesPostalFile: string | null
	/**
	 * WOF SQLite DB (the admin gazetteer) holding `spr` (place coords + placetype) +
	 * `place_population` / `place_importance` — the CIVILIZATION/salience backdrop. Settlement
	 * places, weighted by salience, mark "where civilization is": a salient place we DON'T cover is a
	 * gray hole = work to do. Null to skip the global holes layer (US rooftop fine map is independent
	 * of it).
	 */
	wofDb: string | null
	/**
	 * Coverage a postcode cell contributes (≤ 1) — how much it clears the hole (rooftop is the full
	 * 1).
	 */
	postcodeCeiling: number
	/** Minimum place importance (∈ [0,1]) to count as civilization worth flagging — the noise floor. */
	salienceFloor: number
	/** Country codes the global holes/postcode layer skips (US is handled by the rooftop fine map). */
	postcodeExcludeCountries: string[]
	/** Highest zoom baked; MapLibre overzooms above it. */
	tileMaxZoom: number
	/** Output `.pmtiles` path. */
	out: string
	/** Keep the intermediate NDJSON (for re-tiling without re-aggregating). */
	keepNdjson: boolean
	/** DuckDB worker-thread cap (omit for all cores). */
	threads?: number
}

export type CoverageProgress = (stage: string, message: string) => void

export interface CoverageBuildResult {
	out: string
	states: number
	interpShards: number
	domainCells: number
	withPoints: number
	streetOnly: number
	postcodeCells: number
	features: number
	pmtilesBytes: number
}

interface StateShard {
	slug: string
	file: string
	interp: string | null
}

// The zoom at which each H3 resolution becomes the active fog granularity (hex edge ≈ tile detail there).
const RES_ONSET_ZOOM: Record<number, number> = { 4: 0, 5: 0, 6: 5, 7: 7, 8: 9, 9: 10, 10: 12, 11: 14 }

/** Resolve the shard set + matching interpolation shards. */
function resolveStates(opts: CoverageBuildOptions): StateShard[] {
	const exclude = new Set(opts.excludeStates.map((s) => s.toUpperCase()))
	const files = readdirSync(opts.dataRoot).filter((f) => /^address-points-us-[a-z]+\.db$/.test(f))
	const bySlug = new Map(files.map((f) => [f.replace(/^address-points-us-|\.db$/g, ""), f]))
	const slugs =
		opts.states.toLowerCase() === "all" ? [...bySlug.keys()] : opts.states.split(",").map((s) => s.trim().toLowerCase())
	return slugs
		.filter((slug) => !exclude.has(slug.toUpperCase()))
		.map((slug) => {
			const file = bySlug.get(slug)
			if (!file) throw new Error(`no address-point shard for state '${slug}' under ${opts.dataRoot}`)
			const interpFile = opts.interpRoot ? path.join(opts.interpRoot, `interpolation-us-${slug}.db`) : ""
			return {
				slug,
				file: path.join(opts.dataRoot, file),
				interp: opts.interpRoot && existsSync(interpFile) ? interpFile : null,
			}
		})
}

/**
 * Contiguous, gap-free zoom bands across the chosen resolutions (finest baked at the single
 * tile-max).
 */
function buildBands(allRes: number[], tileMaxZoom: number): Map<number, [number, number]> {
	const asc = [...allRes].sort((a, b) => a - b)
	return new Map(
		asc.map((res, i) => {
			if (i === asc.length - 1) return [res, [tileMaxZoom, tileMaxZoom]] as [number, [number, number]]
			const lo = i === 0 ? 0 : (RES_ONSET_ZOOM[res] ?? 0)
			const nextRes = asc[i + 1]!
			const hi = i === asc.length - 2 ? tileMaxZoom - 1 : (RES_ONSET_ZOOM[nextRes] ?? tileMaxZoom) - 1
			return [res, [lo, hi]] as [number, [number, number]]
		})
	)
}

/**
 * True if a GeoJSON polygon's outer ring spans >180° of longitude — the antimeridian-wrap artifact.
 * `h3_cell_to_boundary_wkt` emits UNWRAPPED lon for cells straddling ±180, smearing a polygon
 * across the whole map; a normal hex spans a fraction of a degree, so a >180° span is unambiguously
 * a wrap. Cheaper than round-tripping through the spatial extension; covers AK/RU/FJ/NZ-Chathams.
 */
function antimeridianWrapped(geojson: string): boolean {
	let min = Infinity
	let max = -Infinity
	// Each coordinate pair is `[lon,lat]`; capture the lon (first number after a `[`). `[[[` won't
	// match (no digit follows the inner `[`), so only real vertices are scanned.
	const re = /\[\s*(-?\d+(?:\.\d+)?)\s*,/g
	for (let m = re.exec(geojson); m; m = re.exec(geojson)) {
		const lon = Number(m[1])
		if (lon < min) min = lon
		if (lon > max) max = lon
	}
	return max - min > 180
}

export async function buildCoverageTiles(
	opts: CoverageBuildOptions,
	onProgress: CoverageProgress = () => {}
): Promise<CoverageBuildResult> {
	let DuckDBInstance: typeof import("@duckdb/node-api").DuckDBInstance
	try {
		;({ DuckDBInstance } = await import("@duckdb/node-api"))
	} catch {
		throw new Error("@duckdb/node-api is not installed — `coverage build` is a maintainer-only data command")
	}

	const ALL_RES = [opts.fineRes, ...opts.rollup]
	const bands = buildBands(ALL_RES, opts.tileMaxZoom)
	const states = resolveStates(opts)
	const interpCount = states.filter((s) => s.interp).length
	onProgress(
		"init",
		`${states.length} shard(s)${opts.interpRoot ? ` (+${interpCount} interp)` : ""} · fine res ${opts.fineRes} · rollup ${opts.rollup.join(",")} · domain res ${opts.domainRes}`
	)

	const instance = await DuckDBInstance.create()
	const duck = await instance.connect()
	if (opts.threads) await duck.run(`SET threads TO ${opts.threads}`)
	await duck.run("INSTALL h3 FROM community; LOAD h3; INSTALL spatial; LOAD spatial; INSTALL sqlite; LOAD sqlite;")

	// ATTACH every shard read-only (address-points as st<i>, interpolation as ip<i> when present).
	for (const [i, s] of states.entries()) {
		await duck.run(`ATTACH '${s.file}' AS st${i} (TYPE sqlite, READ_ONLY)`)
		if (s.interp) await duck.run(`ATTACH '${s.interp}' AS ip${i} (TYPE sqlite, READ_ONLY)`)
	}
	// ATTACH the WOF gazetteer read-only for the global civilization/salience backdrop (if requested).
	if (opts.wofDb) await duck.run(`ATTACH '${opts.wofDb}' AS wof (TYPE sqlite, READ_ONLY)`)

	// data_pt: res-FINE address-point counts. UNION ALL the RAW (lat, lon) across states and bin + count
	// ONCE in the outer query. Do NOT pre-aggregate per UNION arm: DuckDB mis-binds structurally-identical
	// aggregating sqlite subqueries to the first ATTACHed DB, collapsing every state onto the first one's
	// cells. Raw-then-aggregate is correct.
	onProgress("aggregate", "address points → fine cells…")
	const ptAgg = states.map((_, i) => `SELECT lat, lon FROM st${i}.address_point`).join("\nUNION ALL\n")
	await duck.run(
		`CREATE TEMP TABLE data_pt AS SELECT h3_latlng_to_cell(lat, lon, ${opts.fineRes}) AS cell, count(*)::BIGINT AS cnt FROM (${ptAgg}) GROUP BY 1`
	)

	// data_seg: res-FINE street-segment counts. The geometry is a JSON coordinate array; bin its first
	// vertex (a segment is ~block-length). Same raw-then-aggregate discipline as data_pt.
	const segIdx = states.map((s, i) => (s.interp ? i : -1)).filter((i) => i >= 0)
	if (segIdx.length > 0) {
		const segAgg = segIdx
			.map(
				(i) =>
					`SELECT json_extract(geometry, '$[0][1]')::DOUBLE AS lat, json_extract(geometry, '$[0][0]')::DOUBLE AS lon FROM ip${i}.street_segment WHERE geometry IS NOT NULL`
			)
			.join("\nUNION ALL\n")
		onProgress("aggregate", `street segments → fine cells (${segIdx.length} interp shard(s))…`)
		await duck.run(
			`CREATE TEMP TABLE data_seg AS SELECT h3_latlng_to_cell(lat, lon, ${opts.fineRes}) AS cell, count(*)::BIGINT AS cnt FROM (${segAgg}) GROUP BY 1`
		)
	} else {
		await duck.run("CREATE TEMP TABLE data_seg (cell UBIGINT, cnt BIGINT)")
	}

	// domain9: every fine child of a domain-res parent holding EITHER signal, with the address-point count
	// (pt), segment count (seg), and a blended coverage score cov ∈ [0,1] (points strong, segments weak).
	onProgress("domain", "expanding fog neighborhood + blending signals…")
	await duck.run(`
		CREATE TEMP TABLE domain9 AS
		WITH sig AS (SELECT cell FROM data_pt UNION SELECT cell FROM data_seg),
		     parents AS (SELECT DISTINCT h3_cell_to_parent(cell, ${opts.domainRes}) AS parent FROM sig),
		     children AS (SELECT UNNEST(h3_cell_to_children(parent, ${opts.fineRes})) AS cell FROM parents)
		SELECT c.cell AS cell,
		       COALESCE(p.cnt, 0)::BIGINT AS pt,
		       COALESCE(s.cnt, 0)::BIGINT AS seg,
		       LEAST(1.0,
		             LEAST(1.0, ln(1 + COALESCE(p.cnt, 0)) / ln(1 + ${opts.saturation}))
		             + ${opts.interpWeight} * LEAST(1.0, ln(1 + COALESCE(s.cnt, 0)) / ln(1 + ${opts.satSeg}))
		       ) AS cov
		FROM children c
		LEFT JOIN data_pt p USING (cell)
		LEFT JOIN data_seg s USING (cell)
	`)
	const summary = (
		await duck.runAndReadAll(
			"SELECT count(*) AS domain, count(*) FILTER (WHERE pt>0) AS pt_cov, count(*) FILTER (WHERE pt=0 AND seg>0) AS seg_only FROM domain9"
		)
	).getRowObjects()[0] as Record<string, bigint>
	const domainCells = Number(summary.domain)
	const withPoints = Number(summary.pt_cov)
	const streetOnly = Number(summary.seg_only)
	let postcodeCells = 0
	onProgress(
		"domain",
		`${domainCells.toLocaleString()} cells · ${withPoints.toLocaleString()} with points · ${streetOnly.toLocaleString()} street-only`
	)

	// --- Stream features to NDJSON ---
	mkdirSync(path.dirname(opts.out), { recursive: true })
	const ndjsonPath = opts.out.replace(/\.pmtiles$/, "") + ".ndjson"
	const sink = createWriteStream(ndjsonPath)
	let featureCount = 0
	const emitResolution = async (res: number, sql: string, bandOverride?: [number, number]): Promise<void> => {
		const [minzoom, maxzoom] = bandOverride ?? bands.get(res) ?? [0, opts.tileMaxZoom]
		const prefix = `{"type":"Feature","tippecanoe":{"layer":"coverage","minzoom":${minzoom},"maxzoom":${maxzoom}},"properties":`
		const stream = await duck.stream(sql)
		const cols = stream.columnNames()
		for (let chunk = await stream.fetchChunk(); chunk && chunk.rowCount > 0; chunk = await stream.fetchChunk()) {
			for (const r of chunk.getRowObjects(cols) as Record<string, unknown>[]) {
				if (r.geom == null) continue
				if (antimeridianWrapped(String(r.geom))) continue
				const fog = Number(r.fog)
				const props = {
					fog: Math.round(fog * 1000) / 1000,
					fog_opt: Math.round(fog ** opts.optimisticGamma * 1000) / 1000,
					pt: Number(r.pt ?? 0),
					seg: Number(r.seg ?? 0),
					pc: Number(r.pc ?? 0),
					res,
				}
				sink.write(`${prefix}${JSON.stringify(props)},"geometry":${String(r.geom)}}\n`)
				featureCount++
			}
		}
		onProgress("emit", `res ${res} → zoom ${minzoom}–${maxzoom} · ${featureCount.toLocaleString()} features`)
	}

	// Fine resolution: blended coverage fog over the full domain (covered + empty).
	await emitResolution(
		opts.fineRes,
		`SELECT pt, seg, 1.0 - cov AS fog, ST_AsGeoJSON(ST_GeomFromText(h3_cell_to_boundary_wkt(cell))) AS geom FROM domain9`
	)
	// Rollups: coarse fog = 1 − the MEAN coverage of the fine children.
	for (const res of opts.rollup) {
		await emitResolution(
			res,
			`WITH agg AS (SELECT h3_cell_to_parent(cell, ${res}) AS cellR, sum(pt) AS pt, sum(seg) AS seg, avg(cov) AS cov FROM domain9 GROUP BY 1)
			 SELECT pt, seg, 1.0 - cov AS fog, ST_AsGeoJSON(ST_GeomFromText(h3_cell_to_boundary_wkt(cellR))) AS geom FROM agg`
		)
	}

	// --- Global "where do we need data" holes layer (civilization − coverage) ---
	// The map's job worldwide: make it obvious where human civilization is AND whether we cover it. A
	// SALIENT place we don't cover is a gray hole = work to do. We model it as fog = salience·(1−cov):
	//   • salience ∈ [0,1] — WOF settlement places weighted by population/importance (a 1-ring halo), so
	//     a big uncovered city is a dark hole, a hamlet a faint one, the empty steppe nothing.
	//   • cov ∈ [0,1] — postcode presence (GeoNames) clears the hole (a postcode = we can geocode here).
	//     US is excluded — the rooftop fine map above already covers it at street level.
	// Only cells with residual fog (uncovered salient places) are emitted, so the layer is just the
	// HOLES — covered + empty stay clear (basemap). Same `coverage` layer + fog props as the US tier, so
	// the demo renders it unchanged, at res-domainRes [onset…max] + a res-4 low-zoom rollup.
	if (opts.geonamesPostalFile && opts.wofDb) {
		const exclude = opts.postcodeExcludeCountries.map((c) => `'${c.toUpperCase()}'`).join(", ") || "''"
		onProgress("holes", "postcode coverage + civilization salience → holes…")
		// pc_cov: postcode COVERAGE per domain cell — flat presence (postcode ∪ 1-ring), clears the hole.
		await duck.run(`
			CREATE TEMP TABLE pc_cov AS
			WITH data_pc AS (
				SELECT h3_latlng_to_cell(lat, lon, ${opts.domainRes}) AS cell
				FROM (
					SELECT column00 AS cc, TRY_CAST(column09 AS DOUBLE) AS lat, TRY_CAST(column10 AS DOUBLE) AS lon
					FROM read_csv('${opts.geonamesPostalFile}', delim='\t', header=false, quote='', ignore_errors=true, all_varchar=true)
				)
				WHERE lat IS NOT NULL AND lon IS NOT NULL AND lat BETWEEN -90 AND 90 AND lon BETWEEN -180 AND 180
					AND cc NOT IN (${exclude})
			)
			SELECT DISTINCT UNNEST(h3_grid_disk(cell, 1)) AS cell, ${opts.postcodeCeiling}::DOUBLE AS cov FROM data_pc
		`)
		// sal: CIVILIZATION salience per domain cell — WOF settlement places weighted by IMPORTANCE
		// (Wikipedia notability via place_importance, with a population fallback baked in by
		// build-importance). importance is already ∈ [0,1] with major cities ≈ 0.85–0.99, so it IS the
		// salience: a big uncovered city → dark hole, a hamlet → faint. Only places carrying a signal
		// count as "civilization" (the unknown long tail is dropped, not flagged as work-to-do). Each
		// place spreads to a 1-ring halo; a cell's salience is the strongest place touching it.
		await duck.run(`
			CREATE TEMP TABLE sal AS
			WITH places AS (
				-- sqrt lifts the mid-range so even modest uncovered towns read as a visible hole while
				-- keeping the importance ORDER (big cities stay darkest) — "obvious work to do".
				SELECT s.latitude AS lat, s.longitude AS lon, sqrt(imp.importance) AS sal
				FROM wof.spr s JOIN wof.place_importance imp ON imp.id = s.id
				WHERE s.placetype IN ('locality','localadmin','borough','neighbourhood','macrohood','microhood')
					AND s.is_current = 1 AND s.country NOT IN (${exclude})
					AND s.latitude BETWEEN -90 AND 90 AND s.longitude BETWEEN -180 AND 180
					AND imp.importance >= ${opts.salienceFloor}
			),
			spread AS (SELECT UNNEST(h3_grid_disk(h3_latlng_to_cell(lat, lon, ${opts.domainRes}), 1)) AS cell, sal FROM places)
			SELECT cell, max(sal) AS salience FROM spread GROUP BY cell
		`)
		// holes: fog = salience·(1−cov). Keep only residual fog > 0.05 (the actual holes); covered +
		// empty cells are dropped → clear basemap.
		await duck.run(`
			CREATE TEMP TABLE pc_cells AS
			SELECT s.cell AS cell, 0::BIGINT AS pc,
			       s.salience * (1.0 - COALESCE(c.cov, 0)) AS fog
			FROM sal s LEFT JOIN pc_cov c USING (cell)
			WHERE s.salience * (1.0 - COALESCE(c.cov, 0)) > 0.05
		`)
		postcodeCells = Number(
			(await duck.runAndReadAll("SELECT count(*) AS n FROM pc_cells")).getRowObjects()[0]!.n as bigint
		)
		const pcOnset = RES_ONSET_ZOOM[opts.domainRes] ?? 5
		onProgress("holes", `${postcodeCells.toLocaleString()} uncovered-civilization holes → res ${opts.domainRes}`)
		// res-domainRes holes, visible from their onset zoom up through the tile max (overzoomed above).
		await emitResolution(
			opts.domainRes,
			`SELECT pc, fog, ST_AsGeoJSON(ST_GeomFromText(h3_cell_to_boundary_wkt(cell))) AS geom FROM pc_cells`,
			[pcOnset, opts.tileMaxZoom]
		)
		// res-4 low-zoom rollup (mean child fog) for the world/continent view.
		await emitResolution(
			4,
			`WITH agg AS (SELECT h3_cell_to_parent(cell, 4) AS cellR, avg(fog) AS fog FROM pc_cells GROUP BY 1)
			 SELECT 0::BIGINT AS pc, fog, ST_AsGeoJSON(ST_GeomFromText(h3_cell_to_boundary_wkt(cellR))) AS geom FROM agg`,
			[0, pcOnset - 1]
		)
	}

	await new Promise<void>((resolve, reject) => sink.end((err?: Error | null) => (err ? reject(err) : resolve())))

	// --- tippecanoe → PMTiles ---
	onProgress("tile", `tiling ${featureCount.toLocaleString()} features → pmtiles…`)
	const tipArgs = [
		"-o",
		opts.out,
		"-l",
		"coverage",
		"-n",
		"Mailwoman address coverage",
		"-A",
		"© Sister Software · Overture / OpenAddresses / TIGER / GeoNames",
		"--minimum-zoom",
		"0",
		"--maximum-zoom",
		String(opts.tileMaxZoom),
		"--no-tile-size-limit",
		"--no-feature-limit",
		"--read-parallel",
		"--no-progress-indicator",
		"--force",
		ndjsonPath,
	]
	// quiet: tippecanoe's stderr must not leak into the Ink render; we surface it only on failure.
	const tip = await $({ nothrow: true, quiet: true })`tippecanoe ${tipArgs}`
	if (tip.exitCode !== 0) {
		throw new Error(`tippecanoe exited ${tip.exitCode}: ${tip.stderr.slice(-400)}`)
	}

	const { statSync } = await import("node:fs")
	const pmtilesBytes = statSync(opts.out).size

	if (!opts.keepNdjson) rmSync(ndjsonPath, { force: true })

	return {
		out: opts.out,
		states: states.length,
		interpShards: interpCount,
		domainCells,
		withPoints,
		streetOnly,
		postcodeCells,
		features: featureCount,
		pmtilesBytes,
	}
}
