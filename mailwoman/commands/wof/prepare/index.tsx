/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { DatabaseSync } from "node:sqlite"
import { setImmediate } from "node:timers/promises"

import { ProgressBar } from "@inkjs/ui"
import { formatMinutes, formatQuantity, takeAsync, tallyPatternCount } from "@mailwoman/core/resources"
import FastGlob from "fast-glob"
import { Box, Text } from "ink"
import { PathBuilder } from "path-ts"
import { Piscina } from "piscina"
import { useEffect, useState } from "react"
import zod from "zod"

import type { CommandComponent } from "../../../sdk/cli.js"
import type { WorkerInput, WorkerOutput } from "./_app_worker.mjs"

const FILES_PER_BATCH = 500

const ArgumentsSchema = zod.array(zod.string().describe("Path to the Who's On First data directory"))
export { ArgumentsSchema as args }

const OptionsSchema = zod.object({
	unifiedDB: zod
		.string()
		.optional()
		.describe("Path to write a unified SQLite database for the FST builder and resolver."),
})
export { OptionsSchema as options }

const startTime = performance.now()

const WOFPrepare: CommandComponent<typeof OptionsSchema, typeof ArgumentsSchema> = ({
	args: [wofDataAdminDirectory],
	options,
}) => {
	const unifiedDBPath = options.unifiedDB
	const [insertionCount, setInsertionCount] = useState(0)
	const [throughput, setThroughput] = useState(0)
	const [recordCount, setRecordCount] = useState(-1)
	const percentage = recordCount === -1 ? 0 : (insertionCount / recordCount) * 100
	// eslint-disable-next-line react-hooks/purity -- progress UI re-derives elapsed each render
	const elapsed = performance.now() - startTime

	const eta = Number.isFinite(throughput) ? (recordCount - insertionCount) / throughput : NaN

	useEffect(() => {
		if (percentage < 100) return

		setImmediate().then(() => {
			process.exit(0)
		})
	}, [percentage])

	useEffect(() => {
		tallyPatternCount(["*.geojson"], wofDataAdminDirectory!).then(setRecordCount)
	}, [wofDataAdminDirectory])

	useEffect(() => {
		;(async () => {
			// Worker pool is created HERE (not at module scope) so importing this command module — which
			// pastel does eagerly for every CLI invocation — has no side effects and ships no hard
			// dependency on the worker being resolvable at load time.
			const piscina = new Piscina<WorkerInput, WorkerOutput>({
				filename: PathBuilder.from(import.meta.dirname, "_app_worker.mjs").href,
				idleTimeout: 1000 * 10,
				env: {
					WOF_DATA_DIR: process.env.WOF_DATA_DIR || "/tmp/wof-placetype-dbs",
				},
			})
			// The unified-DB helpers live in the optional `@mailwoman/resolver-wof-sqlite` peer. Load them
			// lazily (only when --unified-db is requested) so the published CLI loads without that package —
			// same graceful-optional pattern as `parse --resolve`. Without it, the standalone CLI would crash
			// on startup importing an unpublished workspace (#481 follow-up / clean-install fix).
			let unifiedSchema: typeof import("@mailwoman/resolver-wof-sqlite/unified-schema") | undefined

			if (unifiedDBPath) {
				try {
					unifiedSchema = await import("@mailwoman/resolver-wof-sqlite/unified-schema")
				} catch {
					throw new Error(
						"`wof prepare --unified-db` needs @mailwoman/resolver-wof-sqlite — install it (npm i @mailwoman/resolver-wof-sqlite) and retry."
					)
				}
				const db = new DatabaseSync(unifiedDBPath, { open: true })
				unifiedSchema.createUnifiedSchema(db)
				db.close()
			}

			const matchStream = FastGlob.stream(["**/*.geojson"], {
				cwd: wofDataAdminDirectory!,
				absolute: true,
			})

			let unifiedDB: DatabaseSync | null = null
			let sprInsert: ReturnType<DatabaseSync["prepare"]> | null = null
			let namesInsert: ReturnType<DatabaseSync["prepare"]> | null = null
			let concordancesInsert: ReturnType<DatabaseSync["prepare"]> | null = null
			let populationInsert: ReturnType<DatabaseSync["prepare"]> | null = null

			if (unifiedDBPath) {
				unifiedDB = new DatabaseSync(unifiedDBPath)
				unifiedDB.exec("PRAGMA journal_mode = WAL")
				unifiedDB.exec("PRAGMA synchronous = NORMAL")
				unifiedDB.exec("PRAGMA busy_timeout = 30000")
				sprInsert = unifiedDB.prepare(
					"INSERT OR REPLACE INTO spr (id, parent_id, name, placetype, country, latitude, longitude, is_current, is_deprecated, is_ceased, is_superseded, is_superseding, lastmodified) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
				)
				namesInsert = unifiedDB.prepare(
					"INSERT INTO names (id, name, placetype, country, language, lastmodified) VALUES (?, ?, ?, ?, ?, ?)"
				)
				concordancesInsert = unifiedDB.prepare(
					"INSERT INTO concordances (id, other_id, other_source, lastmodified) VALUES (?, ?, ?, ?)"
				)
				populationInsert = unifiedDB.prepare("INSERT OR REPLACE INTO place_population (id, population) VALUES (?, ?)")
			}

			const tasks: Promise<void>[] = []

			for await (const fileNames of takeAsync(matchStream, FILES_PER_BATCH)) {
				const filePaths = fileNames.map((f) => f.toString())

				const task = piscina.run({ filePaths }).then((result: WorkerOutput) => {
					if (unifiedDB && result.places.length > 0) {
						unifiedDB.exec("BEGIN TRANSACTION")

						for (const p of result.places) {
							sprInsert!.run(
								p.id,
								p.parent_id,
								p.name,
								p.placetype,
								p.country,
								p.latitude,
								p.longitude,
								p.isCurrent,
								p.isDeprecated,
								p.isCeased,
								p.isSuperseded,
								p.isSuperseding,
								p.lastmodified
							)

							for (const n of p.names) {
								if (n.preferred) namesInsert!.run(p.id, n.preferred, p.placetype, p.country, n.language, p.lastmodified)

								if (n.variant && n.variant !== n.preferred)
									namesInsert!.run(p.id, n.variant, p.placetype, p.country, n.language, p.lastmodified)
							}

							for (const [source, value] of Object.entries(p.concordances)) {
								concordancesInsert!.run(p.id, value, source, p.lastmodified)
							}

							if (p.population > 0) populationInsert!.run(p.id, p.population)
						}
						unifiedDB.exec("COMMIT")
					}
					setInsertionCount((count) => count + result.places.length)
				})

				tasks.push(task)
			}

			await Promise.allSettled(tasks)
			await piscina.destroy()

			if (unifiedDB) {
				unifiedSchema!.createUnifiedIndexes(unifiedDB)
				unifiedDB.close()
			}
		})()
	}, [wofDataAdminDirectory, unifiedDBPath])

	useEffect(() => {
		const refreshStats = () => {
			const now = performance.now()
			const elapsedMin = now / 1000 / 60
			setThroughput(insertionCount / Math.max(elapsedMin, 0.001))
		}

		const interval = setInterval(refreshStats, 1000)

		return () => clearInterval(interval)
	}, [insertionCount])

	if (percentage >= 100) {
		return (
			<Box flexDirection="column">
				<Text>Inserted {formatQuantity(insertionCount)} records</Text>
				<Text>Elapsed: {formatMinutes(elapsed / 1000 / 60)} minute(s)</Text>
				<Text>Done!</Text>
			</Box>
		)
	}

	return (
		<Box flexDirection="column">
			<Box>
				<Text>Inserted {formatQuantity(insertionCount)}</Text>
				<Text>&nbsp;of&nbsp;{recordCount === -1 ? "∞" : formatQuantity(recordCount)}</Text>
				<Text>&nbsp;records</Text>
			</Box>

			<Text>{throughput.toFixed(2)}/min</Text>
			<Text>Elapsed: {formatMinutes(elapsed / 1000 / 60)} minute(s)</Text>
			<Text>ETA: {Number.isFinite(eta) ? formatMinutes(eta) : "∞"} minute(s)</Text>

			<Box paddingX={1}>
				<ProgressBar value={percentage} />
				<Text>{percentage.toFixed(2)}%</Text>
			</Box>
		</Box>
	)
}

export default WOFPrepare
