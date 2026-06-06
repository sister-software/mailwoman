/**
 * Loads `sql.js-httpvfs` from the local server, opens the WOF .db over byte-range fetches, and runs
 * the same FTS5 + R*Tree queries the production WofSqlitePlaceLookup uses. Reports cold + warm
 * latency per query to the page (the orchestrator scrapes console output too).
 *
 * The page expects the .db to live at `/wof.db` and the sql.js-httpvfs worker bundle at
 * `/node_modules/sql.js-httpvfs/dist/...` (relative paths from the server root).
 */

// sql.js-httpvfs@0.8.x ships a webpack UMD bundle, not an ES module — index.html loads it as a
// classic script that assigns `createDbWorker` onto window. (A bare ESM `import` from the dist
// fails with "does not provide an export named 'createDbWorker'".)
const { createDbWorker } = /** @type {{ createDbWorker: Function }} */ (window)
if (typeof createDbWorker !== "function") {
	throw new Error("createDbWorker not on window — sql.js-httpvfs UMD bundle failed to load")
}

const logEl = document.getElementById("log")
const lines = []
function log(message) {
	lines.push(message)
	logEl.textContent = lines.join("\n")
	// Also push to console so the orchestrator's CDP hook picks it up.
	console.log("SPIKE", JSON.stringify(message))
}

// Queries chosen to span the access patterns we care about:
// - Exact FTS phrase match against a famous + an obscure name (BM25 cache behavior)
// - Prefix queries (multi-term FTS5)
// - Population-ranked sorts that hit the place_population aux table
// - R*Tree bbox + proximity (different page set from FTS)
// - JOIN across spr + place_search + place_population + place_bbox
const QUERIES = [
	{
		label: "exact: New York",
		sql: `SELECT spr.id, spr.name FROM place_search JOIN spr ON spr.id = place_search.wof_id WHERE place_search MATCH '"New York"' AND spr.is_current != 0 AND spr.is_deprecated = 0 AND spr.placetype = 'locality' LIMIT 10`,
	},
	{
		label: "exact: Springfield",
		sql: `SELECT spr.id, spr.name FROM place_search JOIN spr ON spr.id = place_search.wof_id WHERE place_search MATCH '"Springfield"' AND spr.is_current != 0 AND spr.is_deprecated = 0 AND spr.placetype = 'locality' LIMIT 10`,
	},
	{
		label: "prefix: 902*",
		sql: `SELECT spr.id, spr.name FROM place_search JOIN spr ON spr.id = place_search.wof_id WHERE place_search MATCH '902*' LIMIT 10`,
	},
	{
		label: "ranked: New York by population",
		sql: `SELECT spr.id, spr.name, place_population.population FROM place_search JOIN spr ON spr.id = place_search.wof_id LEFT JOIN place_population ON place_population.id = spr.id WHERE place_search MATCH '"New York"' AND spr.placetype = 'locality' ORDER BY bm25(place_search) - 4.0 * MIN(1.0, COALESCE(log10(1.0 + place_population.population), 0) / 6.0) ASC LIMIT 10`,
	},
	{
		label: "bbox: Illinois bounding box",
		sql: `SELECT spr.id, spr.name FROM place_bbox JOIN spr ON spr.id = place_bbox.id WHERE place_bbox.min_lat <= 42.5 AND place_bbox.max_lat >= 37.0 AND place_bbox.min_lon <= -87.0 AND place_bbox.max_lon >= -91.5 AND spr.placetype = 'locality' LIMIT 10`,
	},
	{
		label: "proximity: near Springfield IL",
		sql: `SELECT spr.id, spr.name FROM place_search JOIN spr ON spr.id = place_search.wof_id JOIN place_bbox ON place_bbox.id = spr.id WHERE place_search MATCH '"Springfield"' AND place_bbox.min_lat <= 40.5 AND place_bbox.max_lat >= 39.0 AND place_bbox.min_lon <= -89.0 AND place_bbox.max_lon >= -90.5 LIMIT 10`,
	},
	{
		label: "warm: New York repeat",
		sql: `SELECT spr.id, spr.name FROM place_search JOIN spr ON spr.id = place_search.wof_id WHERE place_search MATCH '"New York"' AND spr.placetype = 'locality' LIMIT 10`,
	},
	{
		label: "warm: Springfield repeat",
		sql: `SELECT spr.id, spr.name FROM place_search JOIN spr ON spr.id = place_search.wof_id WHERE place_search MATCH '"Springfield"' AND spr.placetype = 'locality' LIMIT 10`,
	},
]

async function main() {
	const t0 = performance.now()
	log({ phase: "init", note: "constructing worker" })

	const worker = await createDbWorker(
		[
			{
				from: "inline",
				config: {
					serverMode: "full",
					url: "/wof.db",
					// 64 KiB request size — bigger than the SQLite page (often 4 KiB) but small enough to
					// keep cold-start traffic reasonable. The library coalesces adjacent reads.
					requestChunkSize: 65536,
				},
			},
		],
		"/node_modules/sql.js-httpvfs/dist/sqlite.worker.js",
		"/node_modules/sql.js-httpvfs/dist/sql-wasm.wasm"
	)
	const t1 = performance.now()
	log({ phase: "worker-ready", ms: Math.round(t1 - t0) })

	for (const q of QUERIES) {
		const start = performance.now()
		let rows
		let error = null
		try {
			rows = await worker.db.exec(q.sql)
		} catch (e) {
			error = String(e?.message ?? e)
			rows = null
		}
		const elapsed = performance.now() - start
		log({
			phase: "query",
			label: q.label,
			ms: Math.round(elapsed),
			rows: rows?.[0]?.values?.length ?? 0,
			error,
		})
	}

	log({ phase: "done" })
	// Signal to the orchestrator that we're complete.
	window.__SPIKE_DONE__ = true
}

main().catch((e) => {
	log({ phase: "fatal", error: String(e?.stack ?? e) })
	window.__SPIKE_DONE__ = true
})
