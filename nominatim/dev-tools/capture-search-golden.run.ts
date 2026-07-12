/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Phase-0: golden `/search` wire responses from the CURRENT nominatim drop-in (neural geocode +
 *   rules streetParts recovery). Spawns its own server child on a scratch port and kills ONLY that
 *   PID (house rule: never kill by pattern). Needs the lab data-root (weights + gazetteer).
 *   Run from the repo root AFTER `yarn compile`:
 *   `node nominatim/dev-tools/capture-search-golden.run.ts`
 */

import { spawn } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"

const PORT = 8199
const BASE = `http://127.0.0.1:${PORT}`
const PARITY_PATH = "mailwoman/test-fixtures/legacy-golden/parity-inputs.jsonl"
const SYNTHETIC_PATH = "mailwoman/test-fixtures/legacy-golden/synthetic-inputs.txt"
const OUT_PATH = "nominatim/test-fixtures/search-golden.jsonl"

interface ParityRow {
	input: string
	expected: Array<Record<string, unknown> | string>
}

const parity = readFileSync(PARITY_PATH, "utf8")
	.split("\n")
	.filter(Boolean)
	.map((line) => JSON.parse(line) as ParityRow)

// The streetParts leg only fires when a house number is in play — feed it the cases that have one.
const withHouseNumber = parity
	.filter((row) =>
		row.expected.some((record) => typeof record === "object" && record !== null && "house_number" in record)
	)
	.map((row) => row.input)

const syntheticInputs = readFileSync(SYNTHETIC_PATH, "utf8")
	.split("\n")
	.map((line) => line.trim())
	.filter(Boolean)

const queries = [...new Set([...withHouseNumber.slice(0, 172), ...syntheticInputs])]

const child = spawn("node", ["nominatim/out/cli.js", "serve", "--port", String(PORT)], {
	stdio: ["ignore", "inherit", "inherit"],
})

try {
	const deadline = Date.now() + 180_000

	// Model + gazetteer boot takes a while; poll /status until the server answers.
	for (;;) {
		try {
			const res = await fetch(`${BASE}/status`)

			if (res.ok) break
		} catch {
			// Not listening yet.
		}

		if (Date.now() > deadline) throw new Error("nominatim serve did not become ready within 180s")
		await new Promise((resolve) => setTimeout(resolve, 1000))
	}

	const rows: string[] = []

	for (const query of queries) {
		const res = await fetch(`${BASE}/search?q=${encodeURIComponent(query)}&format=jsonv2&addressdetails=1`)

		rows.push(JSON.stringify({ query, status: res.status, body: await res.json() }))
	}

	writeFileSync(OUT_PATH, rows.join("\n") + "\n")
	console.error(
		`captured ${rows.length} /search responses (${withHouseNumber.length} house-number parity cases available)`
	)
} finally {
	child.kill("SIGTERM")
}
