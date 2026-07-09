/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Minimal static file server that honours HTTP Range requests (206) — Python's `http.server` does
 *   not, and PMTiles reads via Range, so it can't be served by it. Used to preview/render a local
 *   `.pmtiles` tileset (e.g. the race-dot map, via `mailwoman tiger race-dots-map --serve`). Not for
 *   production; the deployed tiles go through the tile worker.
 *
 *   Internal helper module — no standalone command.
 */

import { createReadStream, statSync, type Stats } from "node:fs"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { extname, join, normalize } from "node:path"

/** Options for {@linkcode serveWithRangeSupport}. */
export interface ServeRangeOptions {
	/** Directory to serve. Default `/tmp`. */
	dir?: string
	/** Port to listen on. Default 8899. */
	port?: number
}

/** A running range-capable static server, resolved once listening. */
export interface RangeServer {
	dir: string
	port: number
	server: Server
	close: () => void
}

const TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".json": "application/json",
	".pmtiles": "application/octet-stream",
	".pbf": "application/x-protobuf",
	".png": "image/png",
}

/**
 * Serve `dir` over localhost with HTTP Range support. Resolves once the server is listening; the caller owns the
 * lifetime (`close()` to stop — commands typically hold the process open instead).
 */
export function serveWithRangeSupport(
	options: ServeRangeOptions = {},
	report?: (line: string) => void
): Promise<RangeServer> {
	const dir = options.dir || "/tmp"
	const port = options.port ?? 8899

	const server = createServer((req: IncomingMessage, res: ServerResponse) => {
		const rel = normalize(decodeURIComponent((req.url || "/").split("?")[0]!)).replace(/^(\.\.[/\\])+/, "")
		const path = join(dir, rel)
		let st: Stats

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
	})

	return new Promise<RangeServer>((resolve, reject) => {
		server.once("error", reject)
		server.listen(port, () => {
			report?.(`range server: ${dir} on http://localhost:${port}`)
			resolve({ dir, port, server, close: () => server.close() })
		})
	})
}
