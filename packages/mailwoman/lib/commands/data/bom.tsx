/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Write the CycloneDX document naming every data artifact a release can deliver, with the terms each one
 *   carries. `docs/src/pages/license.mdx` renders its bundle table from the committed copy.
 *
 *   Output goes through {@linkcode writeRawStdout} rather than Ink because an Ink frame at least as tall as the
 *   viewport emits `\x1b[2J\x1b[3J\x1b[H`, and `3J` wipes the scrollback.
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { pathExists } from "@mailwoman/core/fs/readers"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { repoRootPathBuilder } from "@mailwoman/core/paths"

import { type CommandSpec, CommandTaskResult, type CommandComponent, useCommandTask, writeRawStdout } from "#cli-kit"
import { readMailwomanManifest } from "#cli/kit/metadata"
import { buildDataBOM, dataBOMPath, serializeDataBOM } from "#data/bom"
import { takeInventory } from "#data/inventory"
import { readPublishedBundlesSnapshot } from "#data/published-bundles"

export const description =
	"Write the data bill of materials: one CycloneDX 1.5 component per artifact a release can deliver, " +
	"carrying its license expression, the basis of that expression, and the publishers' conditions."

/**
 * Native command-line interface consumed by the filesystem command router.
 */
export const spec = {
	name: "bom",
	description,
	options: {
		json: { type: "boolean", default: false, description: "Write the document to stdout instead of to the file" },
		out: { type: "string", description: "Override the output path" },
		"data-root": { type: "string", description: "Override the data root" },
		"skip-inventory": {
			type: "boolean",
			default: false,
			description:
				"Leave out the data root's manifested databases. The document then carries the four bundles alone, " +
				"and no component records attribution, source vintage or build revision",
		},
	},
} as const satisfies CommandSpec

const DataBOMCommand: CommandComponent<typeof spec> = ({ options }) => {
	const state = useCommandTask(async () => {
		const snapshot = await readPublishedBundlesSnapshot()
		const { version } = await readMailwomanManifest()
		const dataRoot = options.dataRoot ?? dataRootPath()

		// A data root absent from this host yields zero manifested databases.
		// The document would then state a data root holding none.
		// The inventory is left out instead, and the metadata carries no `mailwoman:dataRoot` property at all.
		const inventory =
			options.skipInventory || !(await pathExists(dataRoot)) ? undefined : await takeInventory({ dataRoot })

		const document = buildDataBOM({ mailwomanVersion: version, snapshot, inventory })
		const serialized = serializeDataBOM(document)

		if (options.json) {
			writeRawStdout(serialized)

			return { path: null, components: document.components.length }
		}

		const path = options.out ?? repoRootPathBuilder()(dataBOMPath(version)).toString()

		await writeLocalTextFile(serialized, path)

		return { path, components: document.components.length }
	})

	if (state.status !== "done") return <CommandTaskResult state={state} />

	if (state.result.path) {
		writeRawStdout(`wrote ${state.result.path}\n  ${state.result.components} data components\n`)
	}

	return null
}

export default DataBOMCommand
