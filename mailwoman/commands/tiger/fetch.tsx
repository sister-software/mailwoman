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

import { Spinner } from "@inkjs/ui"
import { Box, Text } from "ink"
import { useState } from "react"
import zod from "zod"

import { type CommandComponent, commandError, useCommandTask } from "../../cli-kit/index.ts"

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
	const state = useCommandTask(async () => {
		if (!/^\d{2}$/.test(options.state)) {
			throw commandError(`--state must be a two-digit FIPS code (got "${options.state}")`)
		}

		// `@mailwoman/tiger` is an OPTIONAL dependency (the census-TIGER fetch tooling is for
		// operators building the street tier, not end-user geocoding) — imported lazily here so a
		// clean geocoding-only install of the CLI never loads it at startup, and a missing optional
		// dep degrades to a friendly message instead of crashing the whole CLI.
		let fetchTIGER: typeof import("@mailwoman/tiger/sdk").fetchTIGER

		try {
			;({ fetchTIGER } = await import("@mailwoman/tiger/sdk"))
		} catch {
			throw commandError(
				"`tiger fetch` needs the optional @mailwoman/tiger package — install it with: npm install @mailwoman/tiger"
			)
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
				setStatus(`Loading blocks… ${ev.inserted.toLocaleString()}${ev.total ? ` / ${ev.total.toLocaleString()}` : ""}`)
			}
			next = await gen.next()
		}

		return { inserted: next.value.inserted, outPath: next.value.outPath, table: next.value.table }
	})

	if (state.status === "error") return <Text color="red">{state.message}</Text>

	if (state.status === "done") {
		return (
			<Box flexDirection="column">
				<Text>
					Loaded <Text bold>{state.result.inserted.toLocaleString()}</Text> rows into{" "}
					<Text bold>{state.result.table}</Text> ({state.result.outPath}).
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
