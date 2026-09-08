/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman tiles publish` — upload a PMTiles archive to the Cloudflare R2 bucket the tile worker serves from. The
 *   upload itself is `publishTiles` in `#tiles/publish`, which the planetary pipeline calls as a function; this file
 *   is the command's contract and its Ink rendering.
 */

import { Spinner } from "@inkjs/ui"

import { type CommandSpec, CommandTaskResult, type ParsedCommandComponent, useCommandTask } from "#cli-kit"
import { publishTiles, type PublishTilesOptions } from "#tiles/publish"

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "publish",
	description: "Publish a PMTiles archive to Cloudflare R2.",
	options: {
		file: { type: "string", required: true, description: "Path to the .pmtiles archive to upload" },
		tileset: { type: "string", required: true, description: "Tile-set name" },
		bucket: { type: "string", default: "nexus-assets", description: "R2 bucket" },
		prefix: { type: "string", default: "tiles", description: "R2 key prefix" },
		"dry-run": { type: "boolean", default: false, description: "Print the target without uploading" },
	},
} as const satisfies CommandSpec

const TilesPublish: ParsedCommandComponent<PublishTilesOptions> = ({ options }) => {
	const state = useCommandTask(async () => publishTiles(options))

	return (
		<CommandTaskResult state={state} running={<Spinner label={`publishing ${options.tileset}.pmtiles to R2…`} />} />
	)
}

export default TilesPublish
