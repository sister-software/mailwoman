// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   `mailwoman tiles overlays` — build and publish the `wof` and `gazetteer` overlay
 *   tile sets from their sources, fetching what the work directory lacks.
 *
 *   The build is `buildOverlayTiles` in `#tools/tiles/overlays`, and the `overlay-tiles`
 *   container image runs this command as its entry point.
 */

import { type CommandSpec, CommandTaskResult, type CommandComponent, useCommandTask, useStageProgress } from "#cli-kit"
import { $private } from "#env"

/**
 * Native command-line interface consumed by the filesystem command router.
 */
export const spec = {
	name: "overlays",
	description: "Build and publish the Who's On First and combined-gazetteer overlay tile sets.",
	options: {
		work: { type: "string", required: true, description: "Work directory for clones, exports and archives" },
		"tileset-version": { type: "string", required: true, description: "Tile set version, such as v1 for wof.v1" },
		admin: { type: "string", required: true, description: "Admin database: a local path or an s3:// URL" },
		countries: { type: "string", description: "Comma-separated lower-case country codes. Default every country" },
		repos: { type: "string", description: "Directory of existing clones. Default: clone into the work directory" },
		"export-copy": { type: "string", description: "s3:// prefix that receives a copy of both exports" },
		"max-zoom": { type: "string", description: "Highest zoom of each archive. Default 12" },
		hrt: { type: "string", description: "The hrt program. Default hrt on the path" },
		bucket: { type: "string", default: $private.MAILWOMAN_TILES_BUCKET, description: "R2 bucket" },
		prefix: { type: "string", default: $private.MAILWOMAN_TILES_PREFIX, description: "R2 key prefix" },
		"dry-run": { type: "boolean", default: false, description: "Build everything and print the publish targets" },
	},
} as const satisfies CommandSpec

const TilesOverlays: CommandComponent<typeof spec> = ({ options }) => {
	const progress = useStageProgress<string>({ describe: String })

	const state = useCommandTask(async () => {
		const { buildOverlayTiles } = await import("#tools/tiles/overlays")

		const report = await buildOverlayTiles({
			work: options.work,
			version: options.tilesetVersion,
			admin: options.admin,
			bucket: options.bucket,
			prefix: options.prefix,
			dryRun: options.dryRun,
			...(options.countries ? { countries: options.countries.split(",") } : {}),
			...(options.repos ? { reposDir: options.repos } : {}),
			...(options.exportCopy ? { exportCopy: options.exportCopy } : {}),
			...(options.maxZoom ? { maxZoom: Number(options.maxZoom) } : {}),
			...(options.hrt ? { hrt: options.hrt } : {}),
			onPhase: progress.report,
		})

		return report.join("\n")
	})

	return <CommandTaskResult state={state} progress={progress} />
}

export default TilesOverlays
