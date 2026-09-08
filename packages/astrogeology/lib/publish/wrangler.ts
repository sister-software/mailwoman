/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The upload transport this pipeline hands `publishTiles` and `uploadToBucket`: `wrangler r2 object put` under the
 *   account's API token (`CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` in the inherited environment), which is
 *   the credential the tile worker deploys with. Wrangler refuses an object over 300 MiB, so this transport checks
 *   the size first and names the cap; every artifact this pipeline builds at zoom 6 is well under it, and a deeper
 *   zoom that crosses it goes through rclone instead.
 */

import { statPath } from "@mailwoman/core/fs/readers"
import { resolvePackageDirectory } from "@mailwoman/core/module/resolvers"
import { runFile } from "@mailwoman/core/process"
import type { UploadTransport } from "mailwoman/tiles/publish"
import { resolvePath } from "path-ts"

/**
 * The largest object `wrangler r2 object put` accepts.
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

	const bin = String(resolvePath(resolvePackageDirectory("wrangler"), "bin", "wrangler.js"))

	await runFile("node", [bin, "r2", "object", "put", `${bucket}/${key}`, "--file", file, "--remote"])
}
