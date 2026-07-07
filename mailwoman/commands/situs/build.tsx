/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman situs build` — national ADDRESS-POINT (situs) shard build driver. The situs
 *   counterpart to `mailwoman situs interpolation`, but downloadless: every US address point
 *   already lives in one pinned Overture parquet, so this fans the per-state `mailwoman situs
 *   address-points` command out across every covered state.
 *
 *   PARALLELISM: states build concurrently via spliterator's `asyncParallelIterator` (the house
 *   bounded-concurrency primitive — same one `build-unified-wof` uses to fan out file reads behind
 *   a single writer). Each state is an isolated child process (its own DuckDB + SQLite heap), so N
 *   states run at once with no shared-memory risk. To avoid oversubscribing cores, each child's
 *   DuckDB scan is capped at `--threads` (default: cores / concurrency), so concurrency × threads ≈
 *   cores. The per-state steady-state bottleneck is the single-threaded SQLite insert loop, not the
 *   scan, so N concurrent inserts is the real win. Sequentialise via `--concurrency 1`.
 *
 *   Each per-state CHILD owns its own DB's atomic write; this driver only spawns children (skipping
 *   COMPLETE shards) and writes the small `ATTRIBUTION.json` manifest incrementally — so there is
 *   no national-DB temp-then-rename here, the large-artifact atomicity lives one level down in the
 *   shard builder. Progress streams to stderr; the final summary lands on stdout.
 *
 *   LICENSING (measured 2026-06-14): US Overture addresses are NAD (68%, US public domain) +
 *   OpenAddresses (32%, government open data) with ZERO OpenStreetMap/ODbL rows. So the default is
 *   NO license filter — `--license-filter NAD` would drop a third of coverage for no benefit. The
 *   only obligation is ATTRIBUTION: the per-row `overture:<dataset>` provenance is summarized into
 *   `<out-dir>/ATTRIBUTION.json`. Pass `--license-filter <datasets>` to build a narrowed shard.
 *
 *   IDEMPOTENCY: a state is skipped only if its shard is COMPLETE — non-empty `address_point` table
 *   AND the `idx_ap_streetkey` index present. A half-built shard (data inserted, indexing/VACUUM
 *   not reached — e.g. a killed run) is detected as incomplete and rebuilt. `--force` rebuilds
 *   regardless.
 */

import { spawn } from "node:child_process"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { DatabaseSync } from "node:sqlite"

import { dataRootPath } from "@mailwoman/core/utils"
import { Box, Text } from "ink"
import { useEffect, useState } from "react"
import zod from "zod"

import type { CommandComponent } from "../../sdk/cli.js"

const OptionsSchema = zod.object({
	outDir: zod
		.string()
		.optional()
		.describe("Output dir for per-state address-point shards. Default <data-root>/address-points"),
	release: zod.string().default("2026-05-20.0").describe("Overture release tag passed to each per-state build"),
	states: zod
		.string()
		.optional()
		.describe("Comma-separated state slugs (e.g. CA,FL). Omit to build every covered state"),
	licenseFilter: zod
		.string()
		.optional()
		.describe("Comma-separated Overture datasets to keep (narrowed shard). Default: no filter (full coverage)"),
	concurrency: zod.coerce
		.number()
		.int()
		.positive()
		.default(4)
		.describe("States built in parallel (each an isolated child process)"),
	threads: zod.coerce
		.number()
		.int()
		.positive()
		.optional()
		.describe("DuckDB scan threads per child. Default: cores / concurrency"),
	force: zod.boolean().default(false).describe("Rebuild shards even if already complete"),
})

export { OptionsSchema as options }

// Coverage-ranked (largest first, from the 2026-05-20.0 parquet probe). NH + HI carry zero Overture
// address coverage in this release, so they're absent — interpolation-only states. VI (territory)
// included for completeness; harmless if the parser's region→slug map skips it.
const STATES_BY_COVERAGE = [
	"CA",
	"FL",
	"TX",
	"NY",
	"NC",
	"OH",
	"IL",
	"TN",
	"OR",
	"VA",
	"NJ",
	"AZ",
	"MA",
	"IN",
	"WA",
	"AL",
	"MD",
	"CO",
	"KY",
	"MN",
	"AR",
	"MO",
	"IA",
	"WI",
	"OK",
	"UT",
	"CT",
	"MS",
	"PA",
	"NM",
	"WV",
	"KS",
	"NE",
	"MI",
	"ME",
	"GA",
	"MT",
	"DE",
	"ND",
	"DC",
	"RI",
	"ID",
	"VT",
	"AK",
	"LA",
	"WY",
	"SC",
	"SD",
	"NV",
	"VI",
]

type StateResult = {
	state: string
	skipped?: boolean
	code?: number | null
	seconds?: number
	out?: string
	err?: string
}

type StateManifestEntry = { ok: boolean; points?: number; seconds?: number; datasets?: Record<string, number> }

const SitusBuild: CommandComponent<typeof OptionsSchema> = ({ options }) => {
	const [error, setError] = useState<string>()
	const [summary, setSummary] = useState<string[]>()

	useEffect(() => {
		void (async () => {
			try {
				const outDir = options.outDir ?? dataRootPath("address-points")
				const states = (
					options.states ? options.states.split(",").map((s) => s.trim().toUpperCase()) : STATES_BY_COVERAGE
				).filter(Boolean)
				mkdirSync(outDir, { recursive: true })

				const concurrency = Math.max(1, options.concurrency || 4)
				const cores = os.availableParallelism?.() ?? os.cpus().length
				const threads = Math.max(1, options.threads || Math.floor(cores / concurrency))
				// The per-state ADDRESS-POINT builder is now the sibling `situs address-points` command (the
				// old `scripts/build-address-point-shard.ts` was migrated into the CLI). Re-invoke the SAME CLI
				// entry this process was started from, so dev + published installs both resolve correctly.
				const cliEntry = process.argv[1]!
				const ansiPattern = new RegExp(String.fromCharCode(27) + "\\[[0-9;?]*[A-Za-z]", "g")
				const stripAnsi = (s: string) => s.replace(ansiPattern, "")

				console.error(
					`national situs build — ${states.length} states, concurrency=${concurrency}, ${threads} DuckDB threads/state (of ${cores} cores)`
				)

				// spliterator is a heavy bounded-concurrency primitive — imported lazily so merely loading the
				// command tree (e.g. `mailwoman --help`) doesn't pull it at module-eval.
				const { asyncParallelIterator } = await import("spliterator")

				// A shard is COMPLETE iff its address_point table has rows AND the streetkey index exists — the
				// index is the last build step, so its presence means insert + index + VACUUM all finished.
				const isComplete = (dbPath: string): boolean => {
					if (!existsSync(dbPath)) return false

					try {
						const db = new DatabaseSync(dbPath, { readOnly: true })
						const n = (db.prepare("SELECT count(*) AS n FROM address_point").get() as { n: number }).n
						const idx = (
							db
								.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='index' AND name='idx_ap_streetkey'")
								.get() as { n: number }
						).n
						db.close()

						return n > 0 && idx > 0
					} catch {
						return false
					}
				}

				const buildOneState = (state: string): Promise<StateResult> => {
					const dbPath = path.join(outDir, `address-points-us-${state.toLowerCase()}.db`)

					if (!options.force && isComplete(dbPath)) return Promise.resolve({ state, skipped: true })

					return new Promise((resolve) => {
						const argv = [
							cliEntry,
							"situs",
							"address-points",
							"--state",
							state,
							"--release",
							options.release,
							"--out",
							dbPath,
							"--threads",
							String(threads),
						]

						if (options.licenseFilter) {
							argv.push("--license-filter", options.licenseFilter)
						}
						const t = Date.now()
						const child = spawn(process.execPath, argv)
						let out = "",
							err = ""
						child.stdout.on("data", (d) => (out += d))
						child.stderr.on("data", (d) => (err += d))
						child.on("close", (code) =>
							resolve({ state, code, seconds: Number(((Date.now() - t) / 1000).toFixed(1)), out, err })
						)
					})
				}

				const t0 = Date.now()
				const manifest: {
					release: string
					builtAt: string | null
					licenseFilter: string | null
					states: Record<string, StateManifestEntry>
					datasetTotals: Record<string, number>
				} = {
					release: options.release,
					builtAt: null,
					licenseFilter: options.licenseFilter ?? null,
					states: {},
					datasetTotals: {},
				}
				let built = 0,
					skipped = 0,
					failed = 0,
					totalRows = 0
				const attributionPath = path.join(outDir, "ATTRIBUTION.json")

				// asyncParallelIterator yields results AS THEY COMPLETE (out of order), capped at `concurrency`
				// in flight. Each result carries its own state, so out-of-order is fine for the state-keyed
				// manifest.
				for await (const r of asyncParallelIterator(states, concurrency, buildOneState)) {
					if (r.skipped) {
						console.error(`[skip] ${r.state} — complete (use --force to rebuild)`)
						skipped++
						continue
					}

					if (r.code !== 0) {
						console.error(`[FAIL] ${r.state} (${r.seconds}s)\n${stripAnsi(r.err || "").slice(-600)}`)
						manifest.states[r.state] = { ok: false }
						failed++
						continue
					}
					// The child's parse-relevant facts span its Ink summary (stdout) + plain progress (stderr) —
					// combine + strip ANSI, then match WITHOUT line anchors so the summary's "✓ "/"  " render
					// prefixes don't defeat the regex.
					const text = stripAnsi(`${r.out ?? ""}\n${r.err ?? ""}`)
					const pts = Number(text.match(/(\d+) points →/)?.[1] ?? 0)
					const datasets: Record<string, number> = {}

					for (const m of text.matchAll(/overture:(\S+)\s+([\d,]+) rows/g)) {
						const ds = m[1]!,
							n = Number(m[2]!.replace(/,/g, ""))
						datasets[ds] = n
						manifest.datasetTotals[ds] = (manifest.datasetTotals[ds] ?? 0) + n
					}
					manifest.states[r.state] = { ok: true, points: pts, seconds: r.seconds, datasets }
					totalRows += pts
					built++
					console.error(`[ok]   ${r.state} — ${pts.toLocaleString()} points (${r.seconds}s)`)
					manifest.builtAt = new Date(t0).toISOString().slice(0, 10)
					writeFileSync(attributionPath, JSON.stringify(manifest, null, 2))
				}

				const mins = ((Date.now() - t0) / 60000).toFixed(1)
				const lines = [
					`situs: ${outDir}`,
					`built ${built} · skipped ${skipped} · failed ${failed} · ${totalRows.toLocaleString()} total points · ${mins} min`,
					`dataset families:`,
				]

				for (const [ds, n] of Object.entries(manifest.datasetTotals)
					.sort((a, b) => b[1] - a[1])
					.slice(0, 8)) {
					lines.push(`  ${ds.padEnd(28)} ${n.toLocaleString()}`)
				}
				lines.push(`attribution manifest → ${attributionPath}`)
				setSummary(lines)
			} catch (e) {
				setError(e instanceof Error ? e.message : String(e))
			}
		})()
	}, [options])

	useEffect(() => {
		if (summary || error) {
			setImmediate(() => process.exit(error ? 1 : 0))
		}
	}, [summary, error])

	if (error) return <Text color="red">✗ {error}</Text>

	if (summary) {
		return (
			<Box flexDirection="column">
				{summary.map((line, i) => (
					<Text key={i} color={i === 0 ? "green" : undefined}>
						{i === 0 ? "✓ " : "  "}
						{line}
					</Text>
				))}
			</Box>
		)
	}

	return null // progress streams to stderr until the summary lands
}

export default SitusBuild
