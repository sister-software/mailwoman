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
import { useState } from "react"

import { type CommandSpec, type ParsedCommandComponent, CommandError, useCommandTask } from "#cli-kit"

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "redistricting",
	description: "Load Census redistricting block counts.",
	options: {
		state: {
			type: "string",
			required: true,
			validate: (value) => /^\d{2}$/u.test(value),
			validationMessage: "--state must be a two-digit FIPS code.",
			description: "Two-digit state FIPS",
		},
		vintage: { type: "number", default: 2020, description: "Decennial vintage" },
		county: { type: "string", description: "Three-digit county FIPS" },
		out: { type: "string", description: "Output database" },
	},
} as const satisfies CommandSpec

interface Options {
	state: string
	vintage: number
	county?: string
	out?: string
}

const TIGERRedistricting: ParsedCommandComponent<Options> = ({ options }) => {
	const [status, setStatus] = useState("Starting…")

	const state = useCommandTask(async () => {
		// Optional `@mailwoman/tiger` (operator street-tier tooling) — lazy-imported so the geocoding
		// CLI never loads it at startup and a missing optional dep degrades gracefully. See fetch.tsx.
		let fetchRedistricting: typeof import("@mailwoman/tiger/sdk").fetchRedistricting

		try {
			;({ fetchRedistricting } = await import("@mailwoman/tiger/sdk"))
		} catch {
			throw new CommandError(
				"`tiger redistricting` needs the optional @mailwoman/tiger package — install it with: npm install @mailwoman/tiger"
			)
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

			if (ev.phase === "download") {
				setStatus(ev.cached ? `Using cached ${ev.file}` : `Downloaded ${ev.file}`)
			} else if (ev.phase === "extract") {
				setStatus(`Extracted ${ev.file}`)
			} else if (ev.phase === "header") {
				setStatus(`Header parsed: ${ev.blocks.toLocaleString()} blocks`)
			} else if (ev.phase === "load") {
				setStatus(`Loading counts… ${ev.inserted.toLocaleString()}${ev.total ? ` / ${ev.total.toLocaleString()}` : ""}`)
			}

			next = await gen.next()
		}

		return { inserted: next.value.inserted, outPath: next.value.outPath }
	})

	if (state.status === "error") return <Text color="red">{state.message}</Text>

	if (state.status === "done") {
		return (
			<Box flexDirection="column">
				<Text>
					Loaded P.L. race counts for <Text bold>{state.result.inserted.toLocaleString()}</Text> blocks into{" "}
					<Text bold>{state.result.outPath}</Text>.
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
