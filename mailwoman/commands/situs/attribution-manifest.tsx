/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman situs attribution-manifest` — regenerate a COMPLETE situs attribution manifest from
 *   the address-point shards on disk. The national build driver (`mailwoman situs build`) only
 *   records the states it built in a given run, so after incremental / resumed builds its
 *   `ATTRIBUTION.json` undercounts. This reads every `address-points-us-*.db` in the directory and
 *   aggregates the per-row `source` (`overture:<dataset>`) provenance into a full ledger — the
 *   document we owe consumers for the OpenAddresses attribution obligation (NAD is US public
 *   domain; the named OA sources want credit).
 *
 *   This regenerates a small JSON manifest from read-only shards (it builds no large DB), so — as in
 *   the original script — `ATTRIBUTION.json` is written directly in place. Per-shard progress
 *   streams to stderr; the summary lands on stdout.
 */

import { dataRootPath } from "@mailwoman/core/utils"
import { Box, Text } from "ink"
import { readdirSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { useEffect, useState } from "react"
import zod from "zod"
import type { CommandComponent } from "../../sdk/cli.js"

const OptionsSchema = zod.object({
	outDir: zod
		.string()
		.optional()
		.describe("Directory holding the address-points-us-<st>.db shards. Default <data-root>/address-points"),
	release: zod.string().default("2026-05-20.0").describe("Overture release tag stamped into the manifest"),
})

export { OptionsSchema as options }

type StateLedger = { ok: boolean; error?: string; points?: number; datasets?: Record<string, number> }

const SitusAttributionManifest: CommandComponent<typeof OptionsSchema> = ({ options }) => {
	const [error, setError] = useState<string>()
	const [summary, setSummary] = useState<string[]>()

	useEffect(() => {
		void (async () => {
			try {
				const outDir = options.outDir ?? dataRootPath("address-points")
				// Canonical per-state shards only: address-points-us-<2-letter-slug>.db. Excludes county-scoped
				// dev artifacts (e.g. address-points-us-il-cook.db) that overlap a state shard and the CLI never
				// selects.
				const shardFiles = readdirSync(outDir)
					.filter((f) => /^address-points-us-[a-z]{2}\.db$/.test(f))
					.sort()

				const manifest: {
					release: string
					regeneratedFromShards: number
					totalPoints: number
					datasetTotals: Record<string, number>
					states: Record<string, StateLedger>
				} = {
					release: options.release,
					regeneratedFromShards: shardFiles.length,
					totalPoints: 0,
					datasetTotals: {},
					states: {},
				}

				for (const file of shardFiles) {
					const slug = file.replace(/^address-points-us-/, "").replace(/\.db$/, "")
					let db: DatabaseSync
					try {
						db = new DatabaseSync(path.join(outDir, file), { readOnly: true })
					} catch {
						manifest.states[slug] = { ok: false, error: "unreadable" }
						continue
					}
					try {
						const rows = db.prepare("SELECT source, count(*) AS n FROM address_point GROUP BY source").all() as Array<{
							source: string
							n: number
						}>
						const datasets: Record<string, number> = {}
						let points = 0
						for (const { source, n } of rows) {
							const ds = String(source).replace(/^overture:/, "")
							datasets[ds] = Number(n)
							manifest.datasetTotals[ds] = (manifest.datasetTotals[ds] ?? 0) + Number(n)
							points += Number(n)
						}
						manifest.states[slug] = { ok: true, points, datasets }
						manifest.totalPoints += points
						console.error(`${slug.padEnd(8)} ${points.toLocaleString().padStart(12)} points · ${rows.length} sources`)
					} finally {
						db.close()
					}
				}

				// Sort datasetTotals descending for readability.
				manifest.datasetTotals = Object.fromEntries(Object.entries(manifest.datasetTotals).sort((a, b) => b[1] - a[1]))

				const attributionPath = path.join(outDir, "ATTRIBUTION.json")
				writeFileSync(attributionPath, JSON.stringify(manifest, null, 2))

				const lines = [
					`attribution: ${attributionPath}`,
					`${shardFiles.length} shards · ${manifest.totalPoints.toLocaleString()} total points`,
					`top sources:`,
				]
				for (const [ds, n] of Object.entries(manifest.datasetTotals).slice(0, 6)) {
					lines.push(`  ${ds.padEnd(40)} ${n.toLocaleString()}`)
				}
				setSummary(lines)
			} catch (e) {
				setError(e instanceof Error ? e.message : String(e))
			}
		})()
	}, [options])

	useEffect(() => {
		if (summary || error) setImmediate(() => process.exit(error ? 1 : 0))
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

export default SitusAttributionManifest
