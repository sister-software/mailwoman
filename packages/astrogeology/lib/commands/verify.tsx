/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `astrogeology verify --body <moon|mars> [--out <dir>]` — the verify step over a build directory; the logic is
 *   `verifyBody` in `#build/verify`, which the publish runs too.
 */

import { Spinner } from "@inkjs/ui"
import { type CommandSpec, CommandTaskResult, type ParsedCommandComponent, useCommandTask } from "mailwoman/cli-kit"

import { verifyBody } from "#build/verify"
import { parseBody } from "#commands/options"

/**
 * The command's contract, in the shape mailwoman's filesystem router reads.
 */
export const spec = {
	name: "verify",
	description: "Recompute a build's checksums and read its archives' metadata back against the manifest.",
	options: {
		body: { type: "string", required: true, description: "moon or mars" },
		out: { type: "string", description: "The build directory; defaults to the data root's astrogeology/<body>/build" },
	},
} as const satisfies CommandSpec

interface Options {
	body: string
	out?: string
}

const Verify: ParsedCommandComponent<Options> = ({ options }) => {
	const state = useCommandTask(async () => (await verifyBody(parseBody(options.body), options.out)).join("\n"))

	return <CommandTaskResult state={state} running={<Spinner label={`verifying ${options.body}…`} />} />
}

export default Verify
