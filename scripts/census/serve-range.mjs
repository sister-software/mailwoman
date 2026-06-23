/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Minimal static file server that honours HTTP Range requests (206) — Python's `http.server` does
 *   not, and PMTiles reads via Range, so it can't be served by it. Used to preview/render a local
 *   `.pmtiles` tileset (e.g. the race-dot map). Not for production; the deployed tiles go through
 *   the tile worker.
 *
 *   Run: node scripts/census/serve-range.mjs [dir=/tmp] [port=8899]
 */

import { createReadStream, statSync } from "node:fs"
import { createServer } from "node:http"
import { extname, join, normalize } from "node:path"

const DIR = process.argv[2] || "/tmp"
const PORT = Number(process.argv[3] || 8899)

const TYPES = {
	".html": "text/html; charset=utf-8",
	".json": "application/json",
	".pmtiles": "application/octet-stream",
	".pbf": "application/x-protobuf",
	".png": "image/png",
}

createServer((req, res) => {
	const rel = normalize(decodeURIComponent((req.url || "/").split("?")[0])).replace(/^(\.\.[/\\])+/, "")
	const path = join(DIR, rel)
	let st
	try {
		st = statSync(path)
	} catch {
		res.writeHead(404)
		return res.end("not found")
	}
	const type = TYPES[extname(path)] || "application/octet-stream"
	const base = { "Content-Type": type, "Accept-Ranges": "bytes", "Access-Control-Allow-Origin": "*" }
	const range = req.headers.range
	const m = range && /bytes=(\d+)-(\d*)/.exec(range)
	if (m) {
		const start = Number(m[1])
		const end = m[2] ? Number(m[2]) : st.size - 1
		res.writeHead(206, {
			...base,
			"Content-Range": `bytes ${start}-${end}/${st.size}`,
			"Content-Length": end - start + 1,
		})
		createReadStream(path, { start, end }).pipe(res)
	} else {
		res.writeHead(200, { ...base, "Content-Length": st.size })
		createReadStream(path).pipe(res)
	}
}).listen(PORT, () => console.error(`range server: ${DIR} on http://localhost:${PORT}`))
