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

import {
	CommandError,
	type CommandSpec,
	CommandTaskResult,
	type ParsedCommandComponent,
	useCommandTask,
} from "#cli-kit"

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "fetch",
	description: "Fetch TIGER geography into SQLite.",
	options: {
		state: {
			type: "string",
			required: true,
			validate: (value) => /^\d{2}$/u.test(value),
			validationMessage: "--state must be a two-digit FIPS code.",
			description: "State FIPS",
		},
		level: {
			type: "string",
			choices: ["tabblock20", "place", "addrfeat"],
			default: "tabblock20",
			description: "TIGER level",
		},
		vintage: { type: "number", description: "TIGER vintage" },
		county: { type: "string", description: "County FIPS" },
		out: { type: "string", description: "Output database" },
	},
} as const satisfies CommandSpec

interface Options {
	state: string
	level: "tabblock20" | "place" | "addrfeat"
	vintage?: number
	county?: string
	out?: string
}

const TIGERFetch: ParsedCommandComponent<Options> = ({ options }) => {
	const [status, setStatus] = useState("Starting…")

	const state = useCommandTask(async () => {
		// `@mailwoman/tiger` is an OPTIONAL dependency (the census-TIGER fetch tooling is for
		// operators building the street tier, not end-user geocoding) — imported lazily here so a
		// clean geocoding-only install of the CLI never loads it at startup, and a missing optional
		// dep degrades to a friendly message instead of crashing the whole CLI.
		let fetchTIGER: typeof import("@mailwoman/tiger/sdk").fetchTIGER

		try {
			;({ fetchTIGER } = await import("@mailwoman/tiger/sdk"))
		} catch {
			throw new CommandError(
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

	if (state.status === "error") return <CommandTaskResult state={state} />

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
