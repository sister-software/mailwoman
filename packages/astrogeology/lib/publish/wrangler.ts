/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Upload transport that runs `wrangler r2 object put`. Wrangler reads `CLOUDFLARE_API_TOKEN` and
 *   `CLOUDFLARE_ACCOUNT_ID` from the environment.
 */

import { statPath } from "@mailwoman/core/fs/readers"
import { resolvePackageDirectory } from "@mailwoman/core/module/resolvers"
import { runFile } from "@mailwoman/core/process"
import type { UploadTransport } from "mailwoman/tiles/publish"
import { resolvePath } from "path-ts"

/**
 * The largest object `wrangler r2 object put` accepts.
 * Larger files must go through rclone.
 */
const WRANGLER_OBJECT_CAP_BYTES = 300 * 1024 * 1024

/**
 * Put one local file at `bucket/key` through wrangler.
 */
export const uploadWithWrangler: UploadTransport = async ({ file, bucket, key }) => {
	const { size } = await statPath(file)

	if (size > WRANGLER_OBJECT_CAP_BYTES) {
		throw new Error(
			`${file} is ${size.toLocaleString()} bytes; wrangler puts objects up to ${WRANGLER_OBJECT_CAP_BYTES.toLocaleString()} — publish it through rclone`
		)
	}

	const bin = resolvePath(resolvePackageDirectory("wrangler"), "bin", "wrangler.js")

	await runFile("node", [bin, "r2", "object", "put", `${bucket}/${key}`, "--file", file, "--remote"])
}
