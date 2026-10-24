/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { ResourceError } from "@mailwoman/core/errors"
import type { Context } from "hono"

import type { TileWorkerHono } from "#caching"
import { parseRangeHeader } from "#ranges"
import { assertR2KeyMatch, assertR2ObjectBody } from "#storage"

/**
 * A database's path segment: its name and file extension, such as `candidate.db`.
 */
const DATABASE_FILE = /^([a-z0-9_-]+)\.([a-z0-9]+)$/

/**
 * Serves a SQLite artifact from R2 for the browser's httpvfs reader.
 * The reader uses range requests.
 *
 * A `HEAD` request answers the range capability without reading R2.
 * The responses are not cached, because each one holds a byte range of the file.
 */
export async function serveDatabase(c: Context<TileWorkerHono>): Promise<Response> {
	const match = DATABASE_FILE.exec(c.req.param("file") ?? "")
	const databaseName = match?.[1]
	const fileExtension = match?.[2]

	if (!databaseName) throw ResourceError.from(400, "Missing database name")

	if (!fileExtension) throw ResourceError.from(400, "Missing file extension")

	if (c.req.method === "HEAD") {
		return new Response(null, {
			headers: {
				"X-Mailwoman-Request": databaseName,
				"Accept-Ranges": "bytes",
			},
		})
	}

	const rangeHeader = parseRangeHeader(c.req.header("Range") ?? null)

	if (!rangeHeader) {
		throw ResourceError.from(400, "Missing Range header")
	}

	const { offset, length } = rangeHeader

	console.info(`Accessing database ${databaseName}.${fileExtension}`)

	const r2ObjectBody = await c.env.MAILWOMAN_TILES_BUCKET.get(`db/${databaseName}.${fileExtension}`, {
		range: { offset, length },
	})

	assertR2KeyMatch(r2ObjectBody)
	assertR2ObjectBody(r2ObjectBody)

	const rangeData = await r2ObjectBody.arrayBuffer()

	return new Response(rangeData, {
		status: 206,
		headers: [
			["Content-Type", r2ObjectBody.httpMetadata?.contentType],
			["Cache-Control", r2ObjectBody.httpMetadata?.cacheControl],
			["Content-Range", `bytes ${offset}-${rangeData.byteLength}/${r2ObjectBody.size}`],
			["Expires", r2ObjectBody.httpMetadata?.cacheExpiry?.toISOString()],
		].filter((entry): entry is [string, string] => !!entry[1]),
	})
}
