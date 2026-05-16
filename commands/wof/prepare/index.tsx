/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { ProgressBar } from "@inkjs/ui"
import { takeInParallel } from "@mailwoman/core"
import { formatMinutes, formatQuantity, takeAsync, tallyPatternCount } from "@mailwoman/core/resources"
import FastGlob from "fast-glob"
import { Box, Text } from "ink"
import { availableParallelism } from "node:os"
import { setImmediate } from "node:timers/promises"
import { PathBuilder } from "path-ts"
import { Piscina } from "piscina"
import { useCallback, useEffect, useState } from "react"
import zod from "zod"
import { PositionalCommandComponent } from "../../../sdk/cli.js"

type PluckDefaultExport<T> = T extends { default: infer U } ? U : never
type InferPiscina<T> = T extends (...args: never) => unknown ? Piscina<Parameters<T>[0], ReturnType<T>> : never

type PiscinaRunner<T> = InferPiscina<PluckDefaultExport<T>>

const piscina: PiscinaRunner<typeof import("./_app_worker.mjs")> = new Piscina({
	filename: PathBuilder.from(import.meta.dirname, "_app_worker.mjs").href,
	idleTimeout: 1000 * 10,
})

const BATCH_SIZE = availableParallelism()

const ArgumentsSchema = zod.array(zod.string().describe("Path to the Who's On First data directory"))
export { ArgumentsSchema as args }
const startTime = performance.now()

const WOFPrepare: PositionalCommandComponent<typeof ArgumentsSchema> = ({ args: [wofDataAdminDirectory] }) => {
	const [insertionCount, setInsertionCount] = useState(0)
	const [throughput, setThroughput] = useState(0)
	const [recordCount, setRecordCount] = useState(-1)
	const percentage = recordCount === -1 ? 0 : (insertionCount / recordCount) * 100
	const elapsed = performance.now() - startTime

	const eta = Number.isFinite(throughput) ? (recordCount - insertionCount) / throughput : NaN

	useEffect(() => {
		if (percentage < 100) return

		setImmediate().then(() => {
			process.exit(0)
		})
	}, [percentage])

	const delegateInsertion = useCallback(async (filePath: string | Buffer) => {
		if (Date.now()) {
			await piscina.run(filePath.toString())

			return
		}
		return fetch("http://localhost:3000/admin/wof", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				filePath: filePath.toString(),
			}),
		}).then(async (response) => {
			if (response.ok) {
				performance.mark("insertion")
				return
			}

			const body = await response.json().catch(() => null)

			if (body) {
				throw new Error(`Failed to insert record: ${JSON.stringify(body)}`)
			}

			throw new Error(`Failed to insert record: ${response.statusText}`)
		})
	}, [])

	useEffect(() => {
		tallyPatternCount(["*.geojson"], wofDataAdminDirectory!).then(setRecordCount)
	}, [wofDataAdminDirectory])

	useEffect(() => {
		;(async () => {
			const matchStream = FastGlob.stream(["**/*.geojson"], {
				cwd: wofDataAdminDirectory!,
				absolute: true,
			})

			for await (const fileNames of takeAsync(matchStream, BATCH_SIZE)) {
				// console.log("Inserting", fileNames.length, "records")
				// const batchStartTime = performance.now()
				const batchIterator = takeInParallel(fileNames, BATCH_SIZE, delegateInsertion)

				await Array.fromAsync(batchIterator)
				// const batchEndTime = performance.now()

				// console.log(`Batch took ${batchEndTime - batchStartTime}s`)
				setInsertionCount((count) => count + fileNames.length)
			}
		})()
	}, [delegateInsertion, wofDataAdminDirectory])

	useEffect(() => {
		const refreshStats = () => {
			const now = performance.now()

			const insertionMark = performance.getEntriesByName("insertion", "mark")
			const nextThroughput = insertionMark.length / (now / 1000 / 60)

			performance.clearMarks()
			setThroughput(nextThroughput)
		}

		const interval = setInterval(refreshStats, 1000)

		return () => {
			clearInterval(interval)
		}
	}, [])

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
