/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman tiger race-dots-map` — render a race-dots PMTiles tileset as a standalone MapLibre
 *   page (Protomaps basemap under the dot layer). `--serve` also serves the output directory with
 *   HTTP Range support (PMTiles reads via Range) and holds the process open — the long-running
 *   posture of `mailwoman serve`.
 */

import { Box, Text } from "ink"
import { useState } from "react"
import zod from "zod"

import { type CommandComponent, useCommandTask } from "../../cli-kit/index.ts"

const OptionsSchema = zod.object({
	pmtilesUrl: zod
		.string()
		.default("http://localhost:8899/race-dots-oc.pmtiles")
		.describe("Dots tileset URL the page reads client-side"),
	out: zod.string().default("/tmp/race-dots-oc.html").describe("Output HTML path"),
	per: zod.number().default(5).describe("People represented by one dot (title/legend copy)"),
	title: zod.string().optional().describe("Page title (default derives from --per)"),
	lng: zod.number().default(-117.83).describe("Initial map center longitude"),
	lat: zod.number().default(33.68).describe("Initial map center latitude"),
	zoom: zod.number().default(9.4).describe("Initial map zoom"),
	serve: zod
		.boolean()
		.default(false)
		.describe("After writing, serve the output directory with HTTP Range support and stay running"),
	port: zod.number().default(8899).describe("--serve port"),
})

export { OptionsSchema as options }

const report = (line: string): void => console.error(line)

const TIGERRaceDotsMap: CommandComponent<typeof OptionsSchema> = ({ options }) => {
	const [serving, setServing] = useState<{ dir: string; port: number } | null>(null)
	const state = useCommandTask(async () => {
		// Optional `@mailwoman/tiger` (operator census tooling) — lazy-imported so a geocoding-only
		// install of the CLI degrades to a friendly message instead of crashing (see `tiger fetch`).
		let tools: typeof import("@mailwoman/tiger/tools")

		try {
			tools = await import("@mailwoman/tiger/tools")
		} catch {
			throw new Error(
				"`tiger race-dots-map` needs the optional @mailwoman/tiger package — install it with: npm install @mailwoman/tiger"
			)
		}

		const result = await tools.raceDotsMap(
			{
				pmtilesURL: options.pmtilesUrl,
				out: options.out,
				per: options.per,
				title: options.title,
				lng: options.lng,
				lat: options.lat,
				zoom: options.zoom,
			},
			report
		)

		if (options.serve) {
			const { dirname } = await import("node:path")
			const dir = dirname(result.outPath)
			await tools.serveWithRangeSupport({ dir, port: options.port }, report)
			setServing({ dir, port: options.port })

			// Long-running: mirror `mailwoman serve` — keep the task pending so useCommandTask never
			// exits; Ctrl-C stops the server.
			await new Promise<never>(() => {})
		}

		return result
	})

	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>

	if (serving) {
		return (
			<Box flexDirection="column">
				<Text color="green">wrote {options.out}</Text>
				<Text>
					serving {serving.dir} on http://localhost:{serving.port} — open http://localhost:{serving.port}/
					{options.out.split("/").pop()} (Ctrl-C to stop)
				</Text>
			</Box>
		)
	}

	if (state.status === "done") {
		return (
			<Text color="green">
				wrote {state.result.outPath} (pmtiles: {state.result.pmtilesURL})
			</Text>
		)
	}

	return null
}

export default TIGERRaceDotsMap
