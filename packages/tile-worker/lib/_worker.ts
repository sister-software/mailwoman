/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   A Cloudflare Worker that serves PMTiles archives.
 */

import type { ExportedHandler } from "@cloudflare/workers-types"

import { createTileWorkerApp } from "#app"
import type { TileWorkerEnv } from "#caching"

const app = createTileWorkerApp()

const handler: ExportedHandler<TileWorkerEnv> = {
	fetch: (request, env, ctx) => app.fetch(request, env, ctx),
}

export default handler
