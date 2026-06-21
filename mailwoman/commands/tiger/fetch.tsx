/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman tiger fetch --state <FIPS>` — download a state's TIGER tabulation blocks (2020) into a
 *   SQLite database via the Kysely `DatabaseClient`. Geometry is stored as GeoJSON text (no SpatiaLite).
 *
 *   Idempotent: a valid cached ZIP is reused, and re-running a state replaces its rows. Pass
 *   `--county <FIPS3>` to load just one county (handy for downstream per-county work).
 */

import { Spinner } from "@inkjs/ui"
import { fetchTIGER } from "@mailwoman/tiger/sdk"
import { Box, Text } from "ink"
import { setImmediate } from "node:timers/promises"
import { useEffect, useState } from "react"
import zod from "zod"
import type { CommandComponent } from "../../sdk/cli.js"

const OptionsSchema = zod.object({
	state: zod.string().describe("Two-digit state FIPS, e.g. 06 (California)."),
	vintage: zod.number().default(2020).describe("TIGER vintage. Default 2020 (matches the 2020 P.L. 94-171 blocks)."),
	county: zod
		.string()
		.optional()
		.describe("Optional three-digit county FIPS filter, e.g. 059 — loads only that county's blocks."),
	out: zod.string().optional().describe("Output .db path. Default <dataRoot>/tiger/tiger-<vintage>.db."),
})

export { OptionsSchema as options }

const TIGERFetch: CommandComponent<typeof OptionsSchema> = ({ options }) => {
	const [status, setStatus] = useState("Starting…")
	const [result, setResult] = useState<{ inserted: number; outPath: string } | null>(null)
	const [error, setError] = useState<string>()

	useEffect(() => {
		if (!/^\d{2}$/.test(options.state)) {
			setError(`--state must be a two-digit FIPS code (got "${options.state}")`)
			return
		}

		;(async () => {
			const gen = fetchTIGER({
				stateFIPS: options.state,
				vintage: options.vintage,
				county: options.county,
				outPath: options.out,
			})

			let next = await gen.next()
			while (!next.done) {
				const ev = next.value
				if (ev.phase === "download") setStatus(ev.cached ? `Using cached ${ev.file}` : `Downloaded ${ev.file}`)
				else if (ev.phase === "extract") setStatus(`Extracted ${ev.file}`)
				else if (ev.phase === "load")
					setStatus(`Loading blocks… ${ev.inserted.toLocaleString()}${ev.total ? ` / ${ev.total.toLocaleString()}` : ""}`)
				next = await gen.next()
			}

			setResult({ inserted: next.value.inserted, outPath: next.value.outPath })
		})().catch((err) => setError((err as Error).message))
	}, [options.state, options.vintage, options.county, options.out])

	useEffect(() => {
		if (!error) return
		setImmediate().then(() => process.exit(1))
	}, [error])

	useEffect(() => {
		if (!result) return
		// Let Ink paint the summary, then exit (the DB + child processes are already closed).
		setImmediate().then(() => process.exit(0))
	}, [result])

	if (error) return <Text color="red">{error}</Text>

	if (result) {
		return (
			<Box flexDirection="column">
				<Text>
					Loaded <Text bold>{result.inserted.toLocaleString()}</Text> blocks into <Text bold>{result.outPath}</Text>.
				</Text>
			</Box>
		)
	}

	return (
		<Box>
			<Spinner />
			<Text> {status}</Text>
		</Box>
	)
}

export default TIGERFetch
