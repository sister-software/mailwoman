/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   City models as 3D Tiles 1.1, one file per request, from the tiles bucket's `3dtiles/` prefix.
 *
 *   The converter stores each file gzipped. The route sends the stored bytes with `Content-Encoding: gzip`, so the
 *   Worker passes them through and the browser decompresses them. Each request reads one file of one tileset. The
 *   route offers no listing, so a whole city can be fetched only file by file, as the renderer asks for it.
 */

import { ResourceError } from "@mailwoman/core/errors"
import type { Context } from "hono"

import type { TileWorkerHono } from "#caching"
import { assertR2KeyMatch, assertR2ObjectBody } from "#storage"

/**
 * A converted tileset's directory name, such
 * as `13101_chiyoda-ku_pref_2025_citygml_1_op_bldg_3dtiles_13101_chiyoda-ku_lod2`.
 */
export const CITY_TILESET_NAME = "[a-zA-Z0-9_.\\-]+"

/**
 * A file path inside a tileset: `/`-separated names ending in `.json` or `.glb`.
 */
export const CITY_TILESET_FILE = "[a-zA-Z0-9_\\-]+(?:/[a-zA-Z0-9_\\-]+)*\\.(?:json|glb)"

const CONTENT_TYPES: Readonly<Record<string, string>> = {
	json: "application/json",
	glb: "model/gltf-binary",
}

/**
 * Serves one file of a converted city tileset.
 */
export async function serveCityModelFile(c: Context<TileWorkerHono>): Promise<Response> {
	const tileset = c.req.param("tileset") ?? ""
	const file = c.req.param("file") ?? ""
	const extension = file.slice(file.lastIndexOf(".") + 1)
	const contentType = CONTENT_TYPES[extension]

	if (!tileset || !file || !contentType) throw ResourceError.from(400, "Invalid city model path")

	const object = await c.env.MAILWOMAN_TILES_BUCKET.get(`3dtiles/${tileset}/${file}`)

	assertR2KeyMatch(object)
	assertR2ObjectBody(object)

	const response = new Response(c.req.method === "HEAD" ? null : object.body, {
		encodeBody: "manual",
		headers: {
			"Content-Type": contentType,
			"Content-Encoding": "gzip",
			"Content-Length": String(object.size),
			Etag: object.httpEtag,
			"Cache-Control": "public, max-age=86400",
		},
	})

	// The response cache would store the gzip bytes as an unencoded body, so this route
	// answers from R2 every time and the browser caches by `Cache-Control`.
	return response
}
