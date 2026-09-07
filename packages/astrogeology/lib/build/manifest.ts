/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The build manifest: what a build read, what it wrote with each output's SHA-256 and size, and the exact tool
 *   invocations in between. Written beside the outputs, validated before it is written, and the record the verify
 *   step recomputes against.
 */

import { statPath } from "@mailwoman/core/fs/readers"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { sha256File } from "@mailwoman/core/hash"
import { isoSeconds } from "@mailwoman/core/utils"

import type { BuildableBodyID } from "#bodies"
import { type PlanetaryBuildManifest, PlanetaryBuildManifestSchema } from "#schema/manifest"

export interface ManifestOutput {
	tileset: string
	path: string
}

export interface EmitManifestOptions {
	body: BuildableBodyID
	sources: PlanetaryBuildManifest["sources"]
	outputs: ManifestOutput[]
	/**
	 * The tool invocations the build ran, in order, each as its argument vector.
	 */
	transformations: string[][]
}

/**
 * One tool invocation as the manifest records it: the argument vector joined the way a shell would show it.
 */
export function formatTransformation(command: readonly string[]): string {
	return command.map((argument) => (/[\s"']/u.test(argument) ? JSON.stringify(argument) : argument)).join(" ")
}

/**
 * Compute each output's checksum and size, validate, and write `manifest.json` at `outPath`. Answers the manifest.
 */
export async function emitManifest(options: EmitManifestOptions, outPath: string): Promise<PlanetaryBuildManifest> {
	const outputs = await Promise.all(
		options.outputs.map(async (output) => ({
			tileset: output.tileset,
			path: output.path,
			sha256: await sha256File(output.path),
			bytes: (await statPath(output.path)).size,
		}))
	)

	const manifest = PlanetaryBuildManifestSchema.parse({
		schemaVersion: 1,
		body: options.body,
		builtAt: isoSeconds(),
		sources: options.sources,
		outputs,
		transformations: options.transformations.map(formatTransformation),
	})

	await writeLocalJSONFile(manifest, outPath)

	return manifest
}
