// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Write the CycloneDX document naming every data artifact a release can deliver
 *   and the terms each one includes.
 *
 *   `docs/src/pages/license.mdx` renders its bundle table from the committed copy.
 *
 *   Output goes through {@linkcode writeRawStdout} rather than Ink.
 *   An Ink frame at least as tall as the viewport emits
 *   `\x1b[2J\x1b[3J\x1b[H`. The `3J` code wipes the scrollback.
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { repoRootPathBuilder } from "@mailwoman/core/paths"
import { allKeyed } from "@mailwoman/core/promises"
import { CommandError } from "@mailwoman/core/scripting/command"
import { resolvePath } from "path-ts"

import { type CommandSpec, CommandTaskResult, type CommandComponent, useCommandTask, writeRawStdout } from "#cli-kit"
import { buildDataBOM, dataBOMPath, type DataBOMMixedLayer, serializeDataBOM } from "#data/bom"
import { takeInventory } from "#data/inventory"
import { readPublishedBundlesSnapshot } from "#data/published-bundles"
import { readInstallationState } from "#data/state"
import { readMailwomanManifest } from "#metadata"

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
				"Leave out the data root's manifested databases. The document then lists only the four bundles, " +
				"and no component records attribution, source vintage or build revision",
		},
		"address-layers-from": {
			type: "string",
			default: "bucket",
			hint: "bucket|data-root",
			description:
				"Where to read the served address layers that release.config.json's addressLayers pins: the public bucket, " +
				"or the data root's db/ directory. Each layer's sources are listed under its component with their publishers' terms",
		},
	},
} as const satisfies CommandSpec

/**
 * Lists each mixed address layer the release config pins, read from the bucket or the data root.
 *
 * A layer the config pins no version for is recorded as unread.
 * A layer that can't be read throws, because a document missing its sources
 * would read as a layer without any.
 */
async function readMixedLayers(from: string, dataRoot: string) {
	const {
		api: { APIClient },
		releaseConfig: { readReleaseConfig },
		remote: { dataClientHeaders },
		mixedLayer: { bucketLayerFileReader, describeMixedAddressLayer, localLayerFileReader, servedMixedAddressLayers },
	} = await allKeyed({
		api: import("@mailwoman/core/api"),
		releaseConfig: import("@mailwoman/core/release-config"),
		remote: import("#data/remote"),
		mixedLayer: import("#data/mixed-layer"),
	})

	if (from !== "bucket" && from !== "data-root") {
		throw new CommandError(`--address-layers-from takes bucket or data-root, not ${from}`)
	}

	await using client = new APIClient({
		displayName: "mailwoman data bom",
		retry: true,
		minRequestIntervalMs: 50,
		// The bucket's firewall answers axios's Node `http` adapter with Cloudflare's challenge
		// page (403), header or not, and admits the same request through the `fetch` adapter.
		axios: { adapter: "fetch", headers: await dataClientHeaders() },
	})

	const read = from === "bucket" ? bucketLayerFileReader(client) : localLayerFileReader(resolvePath(dataRoot, "db"))
	const layers: DataBOMMixedLayer[] = []
	const unread: Array<{ license: string; reason: string }> = []

	for (const layer of servedMixedAddressLayers(await readReleaseConfig())) {
		if (!layer.version) {
			unread.push({
				license: layer.license,
				reason: `release.config.json's addressLayers pins no ${layer.country} version`,
			})

			continue
		}

		const described = await describeMixedAddressLayer({ license: layer.license, version: layer.version, read })

		layers.push({
			description: described,
			readFrom: read.origin,
			noticePresent: await read.exists(described.noticePath),
		})
	}

	return { layers, unread }
}

const DataBOMCommand: CommandComponent<typeof spec> = ({ options }) => {
	const state = useCommandTask(async () => {
		const snapshot = await readPublishedBundlesSnapshot()
		const { version } = await readMailwomanManifest()
		const dataRoot = options.dataRoot ?? dataRootPath()

		// A data root absent from this host provides no database inventory.
		// Metadata without an inventory could claim that the data root holds none.
		// The metadata has no `mailwoman:dataRoot` property in that case.
		const inventory =
			options.skipInventory || !(await pathExists(dataRoot))
				? undefined
				: await takeInventory({ dataRoot, installation: await readInstallationState(dataRoot) })

		const mixed = await readMixedLayers(options.addressLayersFrom, dataRoot.toString())

		const document = buildDataBOM({
			mailwomanVersion: version,
			snapshot,
			inventory,
			mixedLayers: mixed.layers,
			mixedLayersUnread: mixed.unread,
		})

		const serialized = serializeDataBOM(document)

		if (options.json) {
			writeRawStdout(serialized)

			return { path: null, components: document.components.length, layers: [] }
		}

		const path = options.out ?? repoRootPathBuilder()(dataBOMPath(version)).toString()

		await writeLocalTextFile(serialized, path)

		const layers = mixed.layers.map(
			({ description: layer }) =>
				`  ${layer.id} ${layer.version}: ${layer.sources.length} sources nested under the layer`
		)

		return { path, components: document.components.length, layers }
	})

	if (state.status !== "done") return <CommandTaskResult state={state} />

	if (state.result.path) {
		writeRawStdout(
			[`wrote ${state.result.path}`, `  ${state.result.components} data components`, ...state.result.layers, ""].join(
				"\n"
			)
		)
	}

	return null
}

export default DataBOMCommand
