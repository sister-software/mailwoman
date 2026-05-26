/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { ProgressBar } from "@inkjs/ui"
import { formatMinutes, formatQuantity, takeAsync, tallyPatternCount } from "@mailwoman/core/resources"
import { createUnifiedIndexes, createUnifiedSchema } from "@mailwoman/resolver-wof-sqlite/unified-schema"
import FastGlob from "fast-glob"
import { Box, Text } from "ink"
import { availableParallelism } from "node:os"
import { DatabaseSync } from "node:sqlite"
import { setImmediate } from "node:timers/promises"
import { PathBuilder } from "path-ts"
import { Piscina } from "piscina"
import { useEffect, useState } from "react"
import zod from "zod"
import type { CommandComponent } from "../../../sdk/cli.js"
import type { WorkerInput, WorkerOutput } from "./_app_worker.mjs"

const piscina = new Piscina<WorkerInput, WorkerOutput>({
	filename: PathBuilder.from(import.meta.dirname, "_app_worker.mjs").href,
	idleTimeout: 1000 * 10,
	env: {
		WOF_DATA_DIR: process.env.WOF_DATA_DIR || "/tmp/wof-placetype-dbs",
	},
})

const WORKER_COUNT = availableParallelism()
const FILES_PER_BATCH = 500

const ArgumentsSchema = zod.array(zod.string().describe("Path to the Who's On First data directory"))
export { ArgumentsSchema as args }

const OptionsSchema = zod.object({
	unifiedDb: zod
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
	const unifiedDbPath = options.unifiedDb
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
			if (unifiedDbPath) {
				const db = new DatabaseSync(unifiedDbPath, { open: true })
				createUnifiedSchema(db)
				db.close()
			}

			const matchStream = FastGlob.stream(["**/*.geojson"], {
				cwd: wofDataAdminDirectory!,
				absolute: true,
			})

			const tasks: Promise<void>[] = []

			for await (const fileNames of takeAsync(matchStream, FILES_PER_BATCH)) {
				const filePaths = fileNames.map((f) => f.toString())

				const task = piscina.run({ filePaths, unifiedDbPath }).then((result) => {
					setInsertionCount((count) => count + result.processed)
				})

				tasks.push(task)
			}

			await Promise.all(tasks)

			if (unifiedDbPath) {
				const db = new DatabaseSync(unifiedDbPath, { open: true })
				createUnifiedIndexes(db)
				db.close()
			}
		})()
	}, [wofDataAdminDirectory])

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
