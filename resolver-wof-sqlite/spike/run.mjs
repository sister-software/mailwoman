/**
 * Spike orchestrator. Spawns the local Range-aware HTTP server, launches a headless Chromium via
 * Playwright, loads the spike page, captures console events + network log, writes results to disk.
 *
 * Usage: node run.mjs --db /path/to/whosonfirst-data-admin-us-latest.db
 *
 * Output: ./results.json (machine) + ./RESULTS.md (human)
 */

import { spawn } from "node:child_process"
import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))

function parseArgs(argv) {
	const out = { db: null, port: 8765, headless: true }
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]
		if (a === "--db") out.db = argv[++i]
		else if (a === "--port") out.port = Number(argv[++i])
		else if (a === "--headed") out.headless = false
	}
	if (!out.db) {
		console.error("usage: node run.mjs --db <path-to-wof.db> [--port 8765] [--headed]")
		process.exit(2)
	}
	if (!existsSync(out.db)) {
		console.error(`db not found: ${out.db}`)
		process.exit(2)
	}
	return out
}

async function main() {
	const args = parseArgs(process.argv.slice(2))

	// Stage the DB into a scratch root next to the spike harness — symlink works, copy is fine too.
	// We use a scratch dir so the server doesn't accidentally expose anything beyond the spike.
	const root = mkdtempSync(join(tmpdir(), "mailwoman-spike-"))
	console.error(`Spike root: ${root}`)
	const fs = await import("node:fs/promises")
	const dbSize = (await fs.stat(args.db)).size
	await fs.symlink(args.db, join(root, "wof.db"))
	// Copy the harness files (small) so the server sees them under root.
	for (const f of ["index.html", "client.mjs"]) {
		copyFileSync(join(HERE, f), join(root, f))
	}
	// sql.js-httpvfs worker assets — resolve from Node's module graph so yarn-workspace hoisting
	// is transparent (modules land in the repo root, not the spike dir).
	const sqlJsHttpvfsEntry = fileURLToPath(import.meta.resolve("sql.js-httpvfs"))
	const distSrc = dirname(sqlJsHttpvfsEntry)
	if (!existsSync(join(distSrc, "sqlite.worker.js"))) {
		console.error(`sql.js-httpvfs dist incomplete at ${distSrc}. Run \`yarn install\` from the repo root.`)
		rmSync(root, { recursive: true, force: true })
		process.exit(2)
	}
	await fs.mkdir(join(root, "node_modules", "sql.js-httpvfs"), { recursive: true })
	await fs.cp(distSrc, join(root, "node_modules", "sql.js-httpvfs", "dist"), { recursive: true })

	// Launch the server.
	const serverEvents = []
	const server = spawn(process.execPath, [join(HERE, "server.mjs")], {
		env: { ...process.env, SPIKE_PORT: String(args.port), SPIKE_ROOT: root },
		stdio: ["ignore", "pipe", "inherit"],
	})
	let serverReady = false
	const serverReadyPromise = new Promise((resolve) => {
		let buf = ""
		server.stdout.on("data", (chunk) => {
			buf += chunk
			let nl
			while ((nl = buf.indexOf("\n")) !== -1) {
				const line = buf.slice(0, nl)
				buf = buf.slice(nl + 1)
				if (!line) continue
				try {
					const event = JSON.parse(line)
					serverEvents.push(event)
					if (event.kind === "ready" && !serverReady) {
						serverReady = true
						resolve()
					}
				} catch {
					// non-JSON output — ignore
				}
			}
		})
	})
	await serverReadyPromise
	console.error(`Server up on :${args.port}`)

	const playwright = await import("playwright")
	const browser = await playwright.chromium.launch({ headless: args.headless })
	const context = await browser.newContext()
	const page = await context.newPage()

	const consoleEvents = []
	page.on("console", (msg) => {
		const text = msg.text()
		if (text.startsWith("SPIKE ")) {
			try {
				consoleEvents.push(JSON.parse(text.slice("SPIKE ".length)))
			} catch {
				/* ignore */
			}
		}
	})
	page.on("pageerror", (e) => {
		consoleEvents.push({ phase: "pageerror", error: e.message })
	})

	const startBrowser = Date.now()
	await page.goto(`http://localhost:${args.port}/index.html`, { waitUntil: "networkidle", timeout: 120_000 })
	// Wait until the page reports done.
	await page.waitForFunction(() => window.__SPIKE_DONE__ === true, { timeout: 180_000 })
	const endBrowser = Date.now()

	await browser.close()
	server.kill("SIGTERM")

	const totalDbSize = dbSize

	// Aggregate. Total bytes fetched ≈ sum of `bytes` in range events for /wof.db requests + the
	// asset bytes (worker, wasm).
	const dbRanges = serverEvents.filter((e) => e.kind === "range" && e.url?.startsWith("/wof.db"))
	const assetFulls = serverEvents.filter((e) => e.kind === "full" && !e.url?.startsWith("/wof.db"))
	const dbBytes = dbRanges.reduce((acc, e) => acc + e.bytes, 0)
	const assetBytes = assetFulls.reduce((acc, e) => acc + e.bytes, 0)

	const queries = consoleEvents.filter((e) => e.phase === "query")
	const workerReady = consoleEvents.find((e) => e.phase === "worker-ready")?.ms ?? null

	const results = {
		dbPath: args.db,
		dbSizeBytes: totalDbSize,
		wallClockMs: endBrowser - startBrowser,
		workerReadyMs: workerReady,
		dbFetchCount: dbRanges.length,
		dbBytesFetched: dbBytes,
		assetBytes,
		queries,
		serverEvents,
		consoleEvents,
	}
	writeFileSync(join(HERE, "results.json"), JSON.stringify(results, null, 2))

	// Human-readable summary.
	const lines = []
	lines.push(`# sql.js-httpvfs spike — results\n`)
	lines.push(`**DB**: \`${args.db}\` (${(totalDbSize / 1024 / 1024).toFixed(0)} MB)\n`)
	lines.push(`**Wall clock** (page load → all queries done): ${results.wallClockMs} ms\n`)
	lines.push(`**Worker bootstrap** (sqlite-wasm ready): ${workerReady ?? "n/a"} ms\n`)
	lines.push(`**Total DB fetches**: ${dbRanges.length} range requests, ${(dbBytes / 1024).toFixed(0)} KB total\n`)
	lines.push(`**Asset bytes** (worker JS + WASM): ${(assetBytes / 1024).toFixed(0)} KB\n`)
	lines.push(`\n## Per-query latency\n`)
	lines.push(`| Query | ms | rows | error |`)
	lines.push(`|---|---:|---:|---|`)
	for (const q of queries) {
		lines.push(`| ${q.label} | ${q.ms} | ${q.rows ?? "—"} | ${q.error ?? "—"} |`)
	}
	writeFileSync(join(HERE, "RESULTS.md"), lines.join("\n") + "\n")

	console.error(`\nResults written to:\n  ${join(HERE, "results.json")}\n  ${join(HERE, "RESULTS.md")}`)
	console.error(
		`\nSummary: ${queries.length} queries, ${dbRanges.length} range fetches, ${(dbBytes / 1024).toFixed(0)} KB DB bytes\n`
	)

	// Cleanup scratch dir.
	rmSync(root, { recursive: true, force: true })
}

main().catch((e) => {
	console.error("spike failed:", e)
	process.exit(1)
})
