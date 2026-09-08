/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `astrogeology build --body <moon|mars> [--max-zoom 6] [--out <dir>]` — the whole chain for one body over its
 *   locked sources: rows → features → NDJSON → tippecanoe → metadata; DEM → hillshade → metadata; the search artifact;
 *   the manifest. Refuses when the lock lacks a source: the build reads pins, never the network.
 */

import { Spinner } from "@inkjs/ui"
import { makeDirectories } from "@mailwoman/core/fs/writers"
import { CommandError } from "@mailwoman/core/scripting/command"
import { type CommandSpec, CommandTaskResult, type ParsedCommandComponent, useCommandTask } from "mailwoman/cli-kit"
import { resolvePath } from "path-ts"

import { BODIES, type BuildableBodyID } from "#bodies"
import { buildHillshadePMTiles } from "#build/hillshade"
import { buildDirectory, buildOutputs } from "#build/layout"
import { emitManifest } from "#build/manifest"
import { applyPMTilesMetadata, hillshadeMetadata, nomenclatureMetadata } from "#build/metadata"
import {
	buildNomenclaturePMTiles,
	NOMENCLATURE_LAYERS,
	readNomenclatureRows,
	writeNomenclatureNDJSON,
} from "#build/nomenclature"
import { buildSearchIndex } from "#build/search-index"
import { parseBody, parseMaxZoom } from "#commands/options"
import { featureFromSourceRow } from "#normalize"
import type { PlanetaryBuildManifest } from "#schema/manifest"
import type { PlanetaryNomenclatureFeature } from "#schema/nomenclature"
import { downloadPinned, readLock } from "#sdk/fetch"
import { type PlanetarySource, sourceFor } from "#sdk/sources"

/**
 * The command's contract, in the shape mailwoman's filesystem router reads.
 */
export const spec = {
	name: "build",
	description:
		"Build a body's nomenclature and hillshade archives, search artifact and manifest from its pinned sources.",
	options: {
		body: { type: "string", required: true, description: "moon or mars" },
		"max-zoom": { type: "string", default: "6", description: "The deepest hillshade zoom" },
		out: { type: "string", description: "Output directory; defaults to the data root's astrogeology/<body>/build" },
	},
} as const satisfies CommandSpec

interface Options {
	body: string
	maxZoom: string
	out?: string
}

async function pinnedSource(
	source: PlanetarySource
): Promise<{ path: string; entry: PlanetaryBuildManifest["sources"][number] }> {
	const lock = await readLock()
	const locked = lock[source.id]

	if (!locked)
		throw new CommandError(
			`${source.id} is not in sources.lock.json — run \`astrogeology fetch --body ${source.body}\` first`
		)

	const fetched = await downloadPinned(source)

	return {
		path: fetched.path,
		entry: {
			id: source.id,
			url: source.url,
			sha256: fetched.sha256,
			bytes: fetched.bytes,
			...(locked.snapshot ? { snapshot: locked.snapshot } : {}),
			coordinates: BODIES[source.body].coordinates,
		},
	}
}

export interface BuildReport {
	directory: string
	features: number
	searchEntries: number
	manifest: PlanetaryBuildManifest
}

/**
 * Build one body. `report` receives a line per phase.
 */
export async function buildBody(
	body: BuildableBodyID,
	options: { maxZoom: number; out?: string },
	report: (line: string) => void
): Promise<BuildReport> {
	const directory = buildDirectory(body, options.out)
	const names = buildOutputs(body)

	await makeDirectories(directory)

	const nomenclature = await pinnedSource(sourceFor(body, "nomenclature"))
	const dem = await pinnedSource(sourceFor(body, "dem"))
	const buildVersion = nomenclature.entry.snapshot ?? "unpinned"
	const transformations: string[][] = []

	report(`reading ${nomenclature.path}`)

	const features: PlanetaryNomenclatureFeature[] = []

	for await (const row of readNomenclatureRows(nomenclature.path, NOMENCLATURE_LAYERS[body])) {
		features.push(featureFromSourceRow(body, row))
	}

	report(`${features.length.toLocaleString()} features`)

	const ndjson = String(resolvePath(directory, `${body}.ndjson`))
	const nomenclatureOut = String(resolvePath(directory, names.nomenclature))

	await writeNomenclatureNDJSON(features, ndjson)

	const { command } = await buildNomenclaturePMTiles({ body, ndjsonPath: ndjson, outPath: nomenclatureOut })

	transformations.push(command)
	await applyPMTilesMetadata(nomenclatureOut, nomenclatureMetadata(body, buildVersion))
	report(`wrote ${names.nomenclature}`)

	const hillshadeOut = String(resolvePath(directory, names.hillshade))

	const { commands } = await buildHillshadePMTiles({
		body,
		demPath: dem.path,
		outPath: hillshadeOut,
		maxZoom: options.maxZoom,
	})

	transformations.push(...commands)
	await applyPMTilesMetadata(hillshadeOut, hillshadeMetadata(body, buildVersion, dem.entry.url))
	report(`wrote ${names.hillshade}`)

	const searchOut = String(resolvePath(directory, names.search))
	const searchEntries = await buildSearchIndex(features, searchOut)

	report(`wrote ${names.search} (${searchEntries.toLocaleString()} entries)`)

	const manifest = await emitManifest(
		{
			body,
			sources: [nomenclature.entry, dem.entry],
			outputs: [
				{ tileset: body, path: nomenclatureOut },
				{ tileset: `${body}-hillshade`, path: hillshadeOut },
				{ tileset: `${body}-search`, path: searchOut },
			],
			transformations,
		},
		String(resolvePath(directory, names.manifest))
	)

	report(`wrote ${names.manifest}`)

	return { directory, features: features.length, searchEntries, manifest }
}

const Build: ParsedCommandComponent<Options> = ({ options }) => {
	const state = useCommandTask(async () => {
		const body = parseBody(options.body)
		const report = (line: string) => process.stderr.write(`  ${line}\n`)
		const result = await buildBody(body, { maxZoom: parseMaxZoom(options.maxZoom), out: options.out }, report)

		return [
			`${result.directory}`,
			...result.manifest.outputs.map(
				(output) => `  ${output.tileset}: ${output.bytes.toLocaleString()} bytes, sha256 ${output.sha256.slice(0, 12)}…`
			),
		].join("\n")
	})

	return <CommandTaskResult state={state} running={<Spinner label={`building ${options.body}…`} />} />
}

export default Build
