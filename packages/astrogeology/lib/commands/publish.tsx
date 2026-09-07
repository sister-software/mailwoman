/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `astrogeology publish --body <moon|mars> [--out <dir>] [--dry-run]` — publish a verified build: the two archives
 *   under the tile worker's key layout, the search artifact and the manifest under a versioned prefix on the public
 *   bucket, then fetch each public URL and report its status.
 *
 *   THE VERSION IS PART OF THE KEY so a republish never overwrites an artifact a deployed app pins: the manifest's
 *   build date compacted to `YYYYMMDD` plus the first eight hex characters of the nomenclature archive's SHA-256.
 */

import { Spinner } from "@inkjs/ui"
import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { CommandError } from "@mailwoman/core/scripting/command"
import { type CommandSpec, CommandTaskResult, type ParsedCommandComponent, useCommandTask } from "mailwoman/cli-kit"
import { publishTiles, uploadToBucket } from "mailwoman/tiles/publish"
import { resolvePath } from "path-ts"

import type { BuildableBodyID } from "#bodies"
import { buildDirectory, buildOutputs } from "#commands/build"
import { parseBody } from "#commands/fetch"
import { verifyBody } from "#commands/verify"
import { type PlanetaryBuildManifest, PlanetaryBuildManifestSchema } from "#schema/manifest"

/**
 * The command's contract, in the shape mailwoman's filesystem router reads.
 */
export const spec = {
	name: "publish",
	description: "Publish a verified build to the tile worker's bucket and the public bucket.",
	options: {
		body: { type: "string", required: true, description: "moon or mars" },
		out: { type: "string", description: "The build directory; defaults to the data root's astrogeology/<body>/build" },
		"dry-run": { type: "boolean", default: false, description: "Print the targets without uploading" },
	},
} as const satisfies CommandSpec

interface Options {
	body: string
	out?: string
	dryRun: boolean
}

const TILES_BUCKET = "nexus-assets"
const TILES_PREFIX = "tiles"
const PUBLIC_BUCKET = "mailwoman-assets"
const TILES_ORIGIN = "https://tiles.mailwoman.ai"
const PUBLIC_ORIGIN = "https://public.mailwoman.ai"
const VERSION_HASH_LENGTH = 8

/**
 * The version a build publishes under: its date compacted plus the nomenclature archive's hash prefix.
 */
export function publishVersion(manifest: PlanetaryBuildManifest): string {
	const nomenclature = manifest.outputs.find((output) => output.tileset === manifest.body)

	if (!nomenclature) throw new CommandError(`the manifest carries no ${manifest.body} output`)

	return `${manifest.builtAt.slice(0, 10).replaceAll("-", "")}-${nomenclature.sha256.slice(0, VERSION_HASH_LENGTH)}`
}

/**
 * The public URLs a version's artifacts serve at.
 */
export function publishedURLs(body: BuildableBodyID, version: string) {
	return {
		nomenclatureTileJSON: `${TILES_ORIGIN}/${body}.json`,
		hillshadeTileJSON: `${TILES_ORIGIN}/${body}-hillshade.json`,
		search: `${PUBLIC_ORIGIN}/planetary/${body}/${version}/search.ancestrie`,
		manifest: `${PUBLIC_ORIGIN}/planetary/${body}/${version}/manifest.json`,
	}
}

async function publishBody(body: BuildableBodyID, out: string | undefined, dryRun: boolean): Promise<string> {
	await verifyBody(body, out)

	const directory = buildDirectory(body, out)
	const names = buildOutputs(body)
	const manifest = PlanetaryBuildManifestSchema.parse(await readLocalJSONFile(resolvePath(directory, names.manifest)))
	const version = publishVersion(manifest)
	const lines: string[] = []

	for (const tileset of [body, `${body}-hillshade`]) {
		const file = tileset === body ? names.nomenclature : names.hillshade

		lines.push(
			await publishTiles({
				file: String(resolvePath(directory, file)),
				tileset,
				bucket: TILES_BUCKET,
				prefix: TILES_PREFIX,
				dryRun,
			})
		)
	}

	const prefix = `planetary/${body}/${version}`

	lines.push(
		await uploadToBucket({
			file: String(resolvePath(directory, names.search)),
			bucket: PUBLIC_BUCKET,
			key: `${prefix}/search.ancestrie`,
			dryRun,
		})
	)

	lines.push(
		await uploadToBucket({
			file: String(resolvePath(directory, names.manifest)),
			bucket: PUBLIC_BUCKET,
			key: `${prefix}/manifest.json`,
			dryRun,
		})
	)

	const urls = publishedURLs(body, version)

	if (!dryRun) {
		for (const url of Object.values(urls)) {
			const response = await fetch(url, { method: "HEAD", redirect: "follow" })

			lines.push(`${response.status} ${url}`)
		}
	}

	lines.push(`version ${version}`, `pins: ${urls.search}`, `      ${urls.manifest}`)

	return lines.join("\n")
}

const Publish: ParsedCommandComponent<Options> = ({ options }) => {
	const state = useCommandTask(() => publishBody(parseBody(options.body), options.out, options.dryRun))

	return <CommandTaskResult state={state} running={<Spinner label={`publishing ${options.body}…`} />} />
}

export default Publish
