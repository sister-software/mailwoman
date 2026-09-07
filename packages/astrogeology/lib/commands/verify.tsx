/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `astrogeology verify --body <moon|mars> [--out <dir>]` — re-read a build's manifest, recompute every output's
 *   SHA-256 and size, read each archive's `mailwoman:*` block back and validate it, and refuse on any difference.
 */

import { Spinner } from "@inkjs/ui"
import { readLocalJSONFile, statPath } from "@mailwoman/core/fs/readers"
import { sha256File } from "@mailwoman/core/hash"
import { CommandError } from "@mailwoman/core/scripting/command"
import { type CommandSpec, CommandTaskResult, type ParsedCommandComponent, useCommandTask } from "mailwoman/cli-kit"
import { resolvePath } from "path-ts"

import type { BuildableBodyID } from "#bodies"
import { readMailwomanMetadata } from "#build/metadata"
import { buildDirectory, buildOutputs } from "#commands/build"
import { parseBody } from "#commands/fetch"
import { PlanetaryBuildManifestSchema } from "#schema/manifest"

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

/**
 * Verify one body's build. Answers one line per output; throws naming the first difference.
 */
export async function verifyBody(body: BuildableBodyID, out: string | undefined): Promise<string[]> {
	const directory = buildDirectory(body, out)
	const manifestPath = String(resolvePath(directory, buildOutputs(body).manifest))
	const manifest = PlanetaryBuildManifestSchema.parse(await readLocalJSONFile(manifestPath))

	if (manifest.body !== body) throw new CommandError(`${manifestPath} describes ${manifest.body}, not ${body}`)

	const lines: string[] = []

	for (const output of manifest.outputs) {
		const sha256 = await sha256File(output.path)
		const bytes = (await statPath(output.path)).size

		if (sha256 !== output.sha256) {
			throw new CommandError(`${output.tileset}: sha256 ${sha256} differs from the manifest's ${output.sha256}`)
		}

		if (bytes !== output.bytes) {
			throw new CommandError(`${output.tileset}: ${bytes} bytes on disk, the manifest says ${output.bytes}`)
		}

		if (output.path.endsWith(".pmtiles")) {
			const metadata = await readMailwomanMetadata(output.path)

			if (metadata["mailwoman:body"] !== body) {
				throw new CommandError(`${output.tileset}: archive metadata names ${metadata["mailwoman:body"]}, not ${body}`)
			}

			lines.push(`✓ ${output.tileset}: ${bytes.toLocaleString()} bytes, ${metadata["mailwoman:kind"]}`)
		} else {
			lines.push(`✓ ${output.tileset}: ${bytes.toLocaleString()} bytes`)
		}
	}

	return lines
}

const Verify: ParsedCommandComponent<Options> = ({ options }) => {
	const state = useCommandTask(async () => (await verifyBody(parseBody(options.body), options.out)).join("\n"))

	return <CommandTaskResult state={state} running={<Spinner label={`verifying ${options.body}…`} />} />
}

export default Verify
