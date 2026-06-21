/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman tiger redistricting --state <FIPS>` — download a state's Census 2020 P.L. 94-171 block
 *   race counts (table P2) into the `pl_block` table, keyed on the same block GEOID as `tiger
 *   fetch`'s `tabblock20`. Join the two for block-level race + geometry.
 *
 *   Idempotent: a valid cached ZIP is reused, and re-running a state (or `--county`) replaces its
 *   rows.
 */

import { Spinner } from "@inkjs/ui"
import { Box, Text } from "ink"
import { setImmediate } from "node:timers/promises"
import { useEffect, useState } from "react"
import zod from "zod"
import type { CommandComponent } from "../../sdk/cli.js"

const OptionsSchema = zod.object({
	state: zod.string().describe("Two-digit state FIPS, e.g. 06 (California)."),
	vintage: zod.number().default(2020).describe("Decennial vintage. Default 2020."),
	county: zod
		.string()
		.optional()
		.describe("Optional three-digit county FIPS filter, e.g. 059 — loads only that county's blocks."),
	out: zod.string().optional().describe("Output .db path. Default <dataRoot>/tiger/tiger.db."),
})

export { OptionsSchema as options }

const TIGERRedistricting: CommandComponent<typeof OptionsSchema> = ({ options }) => {
	const [status, setStatus] = useState("Starting…")
	const [result, setResult] = useState<{ inserted: number; outPath: string } | null>(null)
	const [error, setError] = useState<string>()

	useEffect(() => {
		if (!/^\d{2}$/.test(options.state)) {
			setError(`--state must be a two-digit FIPS code (got "${options.state}")`)
			return
		}

		;(async () => {
			// Optional `@mailwoman/tiger` (operator street-tier tooling) — lazy-imported so the geocoding
			// CLI never loads it at startup and a missing optional dep degrades gracefully. See fetch.tsx.
			let fetchRedistricting: typeof import("@mailwoman/tiger/sdk").fetchRedistricting
			try {
				;({ fetchRedistricting } = await import("@mailwoman/tiger/sdk"))
			} catch {
				setError(
					"`tiger redistricting` needs the optional @mailwoman/tiger package — install it with: npm install @mailwoman/tiger"
				)
				return
			}
			const gen = fetchRedistricting({
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
				else if (ev.phase === "header") setStatus(`Header parsed: ${ev.blocks.toLocaleString()} blocks`)
				else if (ev.phase === "load")
					setStatus(
						`Loading counts… ${ev.inserted.toLocaleString()}${ev.total ? ` / ${ev.total.toLocaleString()}` : ""}`
					)
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
		setImmediate().then(() => process.exit(0))
	}, [result])

	if (error) return <Text color="red">{error}</Text>

	if (result) {
		return (
			<Box flexDirection="column">
				<Text>
					Loaded P.L. race counts for <Text bold>{result.inserted.toLocaleString()}</Text> blocks into{" "}
					<Text bold>{result.outPath}</Text>.
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

export default TIGERRedistricting
