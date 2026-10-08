/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The verify step rereads a build's manifest and recomputes each output's SHA-256 and size.
 *   It reads each archive's `mailwoman:*` block and refuses any difference.
 *   The publishing step runs this check before upload.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { statPath } from "@mailwoman/core/fs/readers/stat"
import { sha256File } from "@mailwoman/core/hash"
import { CommandError } from "@mailwoman/core/scripting/command"
import { resolvePath } from "path-ts"

import type { BuildableBodyID } from "#bodies"
import { buildDirectory, buildOutputs } from "#build/layout"
import { readMailwomanMetadata } from "#build/metadata"
import { PlanetaryBuildManifestSchema } from "#schema/manifest"

/**
 * Verify one body's build.
 *
 * Answers one line per output.
 * Throws naming the first difference.
 */
export async function verifyBody(body: BuildableBodyID, out: string | null): Promise<string[]> {
	const directory = buildDirectory(body, out)
	const manifestPath = resolvePath(directory, buildOutputs(body).manifest)
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

			lines.push(`${output.tileset}: ${bytes.toLocaleString()} bytes, ${metadata["mailwoman:kind"]}`)
		} else {
			lines.push(`${output.tileset}: ${bytes.toLocaleString()} bytes`)
		}
	}

	return lines
}
