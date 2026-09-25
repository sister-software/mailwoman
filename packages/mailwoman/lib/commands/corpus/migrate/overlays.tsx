/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman corpus migrate-overlays` — rewrite every overlay parquet of a corpus onto the current row schema.
 *
 *   An overlay slice is one the corpus manifest lists and its base manifest does not, compared by `sha256`. A manifest
 *   records no per-slice overlay marker, and the `source` field that `overlay-manifest` writes is absent from overlays
 *   assembled before it existed.
 *
 *   Each migrated file is written beside its original as `<name>.migrated.parquet`. No file is swapped: pass the
 *   migrated files to `mailwoman corpus overlay-manifest` to assemble the new corpus, so the existing corpus stays
 *   readable by the code that built it.
 */

import { CommandError } from "@mailwoman/core/scripting/command"

import { type CommandSpec, CommandTaskResult, type CommandComponent, useCommandTask } from "#cli-kit"

/**
 * Native command-line interface consumed by the filesystem command router.
 */
export const spec = {
	name: "migrate-overlays",
	description: "Migrate a corpus's overlay parquets onto the current row schema.",
	options: {
		manifest: { type: "string", required: true, description: "MANIFEST.json of the corpus whose overlays to migrate" },
		base: {
			type: "string",
			required: true,
			description: "MANIFEST.json of the base corpus; its slices are skipped",
		},
	},
} as const satisfies CommandSpec

const Cmd: CommandComponent<typeof spec> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { readLocalJSONFile } = await import("@mailwoman/core/fs/readers")
		const { baseManifestFiles, localManifestFilePath } = await import("@mailwoman/corpus/tools")
		const { migrateOverlayParquet } = await import("@mailwoman/corpus/tools/migrate-overlay-parquet")

		type Manifest = Parameters<typeof baseManifestFiles>[0]

		// A slice without a hash would match another slice without one, and an overlay would be skipped as base.
		const readHashedFiles = async (path: string) => {
			const files = baseManifestFiles(await readLocalJSONFile<Manifest>(path))
			const unhashed = files.find((file) => typeof file.sha256 !== "string")

			if (unhashed) throw new CommandError(`${path} lists ${unhashed.path} without a sha256`)

			return files
		}

		const corpusFiles = await readHashedFiles(options.manifest)
		const baseHashes = new Set((await readHashedFiles(options.base)).map((file) => file.sha256))
		const overlays = corpusFiles.filter((file) => !baseHashes.has(file.sha256))

		console.log(`${overlays.length} overlay slices, ${corpusFiles.length - overlays.length} base slices`)

		const refused: string[] = []

		for (const file of overlays) {
			const input = localManifestFilePath(file.path)
			const output = input.replace(/\.parquet$/u, ".migrated.parquet")

			try {
				const summary = await migrateOverlayParquet(input, output)

				console.log(
					`  ${summary.rows.toLocaleString("en-US")} rows  ${Object.keys(summary.bySource).join(", ")}  ${output}`
				)
			} catch (error) {
				refused.push(`${input}: ${(error as Error).message}`)
			}
		}

		if (refused.length) {
			throw new CommandError(
				`${refused.length} of ${overlays.length} overlays were not migrated:\n${refused.join("\n")}`
			)
		}

		return `migrated ${overlays.length} overlays`
	})

	return <CommandTaskResult state={state} />
}

export default Cmd
