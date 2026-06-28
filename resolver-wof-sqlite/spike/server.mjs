/**
 * Tiny static HTTP server with explicit Range-request support. Necessary because sql.js-httpvfs issues byte-range
 * fetches against the .db file; without proper Range handling the VFS errors out or silently downloads the whole file
 * (defeating the entire premise).
 *
 * Logs every request to stdout (one JSON line per fetch) so the orchestrator can aggregate the traffic pattern.
 * Designed for spike use; not production-grade.
 */
import { createReadStream, statSync } from "node:fs"
import { createServer } from "node:http"
import { extname, join, normalize, resolve as resolvePath } from "node:path"

const PORT = Number(process.env["SPIKE_PORT"] ?? 8765)
const ROOT = resolvePath(process.env["SPIKE_ROOT"] ?? process.cwd())

const MIME = {
	".html": "text/html; charset=utf-8",
	".js": "application/javascript; charset=utf-8",
	".mjs": "application/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".wasm": "application/wasm",
	".db": "application/vnd.sqlite3",
}

function safeJoin(root, urlPath) {
	const decoded = decodeURIComponent(urlPath.split("?")[0])
	const joined = normalize(join(root, decoded))

	if (!joined.startsWith(root)) return null

	// path traversal guard
	return joined
}

function logEvent(event) {
	process.stdout.write(JSON.stringify({ ts: Date.now(), ...event }) + "\n")
}

const server = createServer((req, res) => {
	const filePath = safeJoin(ROOT, req.url)

	if (!filePath) {
		res.writeHead(403)
		res.end()

		return
	}
	let stat

	try {
		stat = statSync(filePath)
	} catch {
		logEvent({ kind: "miss", url: req.url })
		res.writeHead(404)
		res.end()

		return
	}

	if (stat.isDirectory()) {
		// Auto-index for the harness path: serve index.html.
		req.url = join(req.url, "index.html")
		const idxPath = safeJoin(ROOT, req.url)

		if (!idxPath) {
			res.writeHead(403)
			res.end()

			return
		}

		try {
			stat = statSync(idxPath)
		} catch {
			res.writeHead(404)
			res.end()

			return
		}
		serveFile(req, res, idxPath, stat)

		return
	}
	serveFile(req, res, filePath, stat)
})

function serveFile(req, res, filePath, stat) {
	const mime = MIME[extname(filePath)] ?? "application/octet-stream"
	const range = req.headers.range

	if (range) {
		// Parse a single "bytes=START-END" range. We don't handle multi-range — sql.js-httpvfs only
		// asks for a single contiguous slice per request.
		const match = /^bytes=(\d+)-(\d*)$/.exec(range)

		if (!match) {
			res.writeHead(416, { "Content-Range": `bytes */${stat.size}` })
			res.end()

			return
		}
		const start = Number(match[1])
		const end = match[2] === "" ? stat.size - 1 : Math.min(Number(match[2]), stat.size - 1)

		if (start > end || start >= stat.size) {
			res.writeHead(416, { "Content-Range": `bytes */${stat.size}` })
			res.end()

			return
		}
		const length = end - start + 1
		logEvent({ kind: "range", url: req.url, start, end, bytes: length })
		res.writeHead(206, {
			"Content-Range": `bytes ${start}-${end}/${stat.size}`,
			"Content-Length": length,
			"Content-Type": mime,
			"Accept-Ranges": "bytes",
			// COOP/COEP so the page can use SharedArrayBuffer (sql.js-httpvfs uses workers + atomics).
			"Cross-Origin-Opener-Policy": "same-origin",
			"Cross-Origin-Embedder-Policy": "require-corp",
			"Cross-Origin-Resource-Policy": "cross-origin",
		})
		createReadStream(filePath, { start, end }).pipe(res)

		return
	}

	logEvent({ kind: "full", url: req.url, bytes: stat.size })
	res.writeHead(200, {
		"Content-Length": stat.size,
		"Content-Type": mime,
		"Accept-Ranges": "bytes",
		"Cross-Origin-Opener-Policy": "same-origin",
		"Cross-Origin-Embedder-Policy": "require-corp",
		"Cross-Origin-Resource-Policy": "cross-origin",
	})
	createReadStream(filePath).pipe(res)
}

server.listen(PORT, () => {
	logEvent({ kind: "ready", port: PORT, root: ROOT })
})
