/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman tiger fetch --state <FIPS>` — download a state's TIGER tabulation blocks (2020) into a
 *   SQLite database via the Kysely `DatabaseClient`. Geometry is stored as GeoJSON text (no
 *   SpatiaLite).
 *
 *   Idempotent: a valid cached ZIP is reused, and re-running a state replaces its rows. Pass
 *   `--county <FIPS3>` to load just one county (handy for downstream per-county work).
 */

import { setImmediate } from "node:timers/promises"

import { Spinner } from "@inkjs/ui"
import { Box, Text } from "ink"
import { useEffect, useState } from "react"
import zod from "zod"

import type { CommandComponent } from "../../cli-kit/index.ts"

const OptionsSchema = zod.object({
	state: zod.string().describe("Two-digit state FIPS, e.g. 06 (California)."),
	level: zod
		.enum(["tabblock20", "place", "addrfeat"])
		.default("tabblock20")
		.describe("TIGER level: tabblock20 (blocks+geometry), place, or addrfeat (streets, per county)."),
	vintage: zod
		.number()
		.optional()
		.describe("TIGER vintage. Default 2020 for blocks (matches the P.L.), 2024 for place/addrfeat."),
	county: zod.string().optional().describe("Optional three-digit county FIPS filter (blocks only)."),
	out: zod.string().optional().describe("Output .db path. Default <dataRoot>/tiger/tiger.db."),
})

export { OptionsSchema as options }

const TIGERFetch: CommandComponent<typeof OptionsSchema> = ({ options }) => {
	const [status, setStatus] = useState("Starting…")
	const [result, setResult] = useState<{ inserted: number; outPath: string; table: string } | null>(null)
	const [error, setError] = useState<string>()

	useEffect(() => {
		if (!/^\d{2}$/.test(options.state)) {
			setError(`--state must be a two-digit FIPS code (got "${options.state}")`)

			return
		}

		;(async () => {
			// `@mailwoman/tiger` is an OPTIONAL dependency (the census-TIGER fetch tooling is for
			// operators building the street tier, not end-user geocoding) — imported lazily here so a
			// clean geocoding-only install of the CLI never loads it at startup, and a missing optional
			// dep degrades to a friendly message instead of crashing the whole CLI.
			let fetchTIGER: typeof import("@mailwoman/tiger/sdk").fetchTIGER

			try {
				;({ fetchTIGER } = await import("@mailwoman/tiger/sdk"))
			} catch {
				setError(
					"`tiger fetch` needs the optional @mailwoman/tiger package — install it with: npm install @mailwoman/tiger"
				)

				return
			}
			const gen = fetchTIGER({
				stateFIPS: options.state,
				level: options.level,
				vintage: options.vintage,
				county: options.county,
				outPath: options.out,
			})

			let next = await gen.next()

			while (!next.done) {
				const ev = next.value

				if (ev.phase === "download") {
					setStatus(ev.cached ? `Using cached ${ev.file}` : `Downloaded ${ev.file}`)
				} else if (ev.phase === "extract") {
					setStatus(`Extracted ${ev.file}`)
				} else if (ev.phase === "load") {
					setStatus(
						`Loading blocks… ${ev.inserted.toLocaleString()}${ev.total ? ` / ${ev.total.toLocaleString()}` : ""}`
					)
				}
				next = await gen.next()
			}

			setResult({ inserted: next.value.inserted, outPath: next.value.outPath, table: next.value.table })
		})().catch((err) => setError((err as Error).message))
	}, [options.state, options.level, options.vintage, options.county, options.out])

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
					Loaded <Text bold>{result.inserted.toLocaleString()}</Text> rows into <Text bold>{result.table}</Text> (
					{result.outPath}).
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
