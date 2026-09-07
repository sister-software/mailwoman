/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `astrogeology fetch --body <moon|mars> [--kind nomenclature|dem]` — pin a body's sources: download each one to the
 *   data root and record its bytes and SHA-256 in `sources.lock.json`. A source already pinned and on disk is reused.
 */

import { Spinner } from "@inkjs/ui"
import { CommandError } from "@mailwoman/core/scripting/command"
import { type CommandSpec, CommandTaskResult, type ParsedCommandComponent, useCommandTask } from "mailwoman/cli-kit"

import { parseBody } from "#commands/options"
import { downloadPinned } from "#sdk/fetch"
import { type PlanetarySourceKind, sourceFor } from "#sdk/sources"

/**
 * The command's contract, in the shape mailwoman's filesystem router reads.
 */
export const spec = {
	name: "fetch",
	description: "Download and pin a body's sources.",
	options: {
		body: { type: "string", required: true, description: "moon or mars" },
		kind: { type: "string", description: "nomenclature or dem; both when omitted" },
	},
} as const satisfies CommandSpec

interface Options {
	body: string
	kind?: string
}

const KINDS: readonly PlanetarySourceKind[] = ["nomenclature", "dem"]

function parseKinds(value: string | undefined): readonly PlanetarySourceKind[] {
	if (value === undefined) return KINDS

	if (KINDS.includes(value as PlanetarySourceKind)) return [value as PlanetarySourceKind]

	throw new CommandError(`--kind must be one of ${KINDS.join(", ")}, got ${JSON.stringify(value)}`)
}

async function fetchSources(options: Options, report: (line: string) => void): Promise<string> {
	const body = parseBody(options.body)
	const lines: string[] = []

	for (const kind of parseKinds(options.kind)) {
		const source = sourceFor(body, kind)
		const fetched = await downloadPinned(source, { onProgress: (message) => report(`${source.id}: ${message}`) })

		lines.push(
			`${fetched.reused ? "reused" : "pinned"} ${source.id}: ${fetched.bytes.toLocaleString()} bytes, sha256 ${fetched.sha256.slice(0, 12)}…`
		)
	}

	return lines.join("\n")
}

const Fetch: ParsedCommandComponent<Options> = ({ options }) => {
	const state = useCommandTask(() => fetchSources(options, (line) => process.stderr.write(`  ${line}\n`)))

	return <CommandTaskResult state={state} running={<Spinner label={`fetching ${options.body} sources…`} />} />
}

export default Fetch
