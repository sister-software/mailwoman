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

import { tempRootPath } from "@mailwoman/core/utils"
import { Box, Text } from "ink"
import { useState } from "react"

import { type CommandSpec, type ParsedCommandComponent, useCommandTask } from "#cli-kit"

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "race-dots-map",
	description: "Render a race-dots PMTiles map.",
	options: {
		"pmtiles-url": {
			type: "string",
			default: "http://localhost:8899/race-dots-oc.pmtiles",
			description: "Dots tileset URL",
		},
		out: { type: "string", default: tempRootPath("race-dots-oc.html"), description: "Output HTML" },
		per: { type: "number", default: 5, description: "People per dot" },
		title: { type: "string", description: "Page title" },
		lng: { type: "number", default: -117.83, description: "Center longitude" },
		lat: { type: "number", default: 33.68, description: "Center latitude" },
		zoom: { type: "number", default: 9.4, description: "Initial zoom" },
		serve: { type: "boolean", default: false, description: "Serve after writing" },
		port: { type: "number", default: 8899, description: "Server port" },
	},
} as const satisfies CommandSpec

interface Options {
	pmtilesUrl: string
	out: string
	per: number
	title?: string
	lng: number
	lat: number
	zoom: number
	serve: boolean
	port: number
}

const report = (line: string): void => console.error(line)

const TIGERRaceDotsMap: ParsedCommandComponent<Options> = ({ options }) => {
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
			const { dirname } = await import("path-ts")
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
