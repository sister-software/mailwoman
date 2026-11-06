// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   R2 uploads through `wrangler r2 object put`. Wrangler reads `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`
 *   from the environment. `wrangler` is an optional peer dependency of this package, so a caller installs it.
 */

import { resolvePath } from "path-ts"

import { statPath } from "#fs/readers/stat"
import { resolvePackageDirectory } from "#module/resolvers"
import { runFile } from "#process"

/**
 * The largest object `wrangler r2 object put` accepts.
 * A larger file goes through rclone.
 */
export const WRANGLER_OBJECT_CAP_BYTES = 300 * 1024 * 1024

/**
 * Put one local file at `bucket/key` on R2.
 *
 * Throws before running wrangler when the file exceeds {@linkcode WRANGLER_OBJECT_CAP_BYTES}.
 */
export async function putR2ObjectWithWrangler({
	file,
	bucket,
	key,
}: {
	file: string
	bucket: string
	key: string
}): Promise<void> {
	const { size } = await statPath(file)

	if (size > WRANGLER_OBJECT_CAP_BYTES) {
		throw new Error(
			`${file} is ${size.toLocaleString()} bytes; wrangler puts objects up to ${WRANGLER_OBJECT_CAP_BYTES.toLocaleString()}, so publish it through rclone`
		)
	}

	const bin = resolvePath(resolvePackageDirectory("wrangler"), "bin", "wrangler.js")

	await runFile("node", [bin, "r2", "object", "put", `${bucket}/${key}`, "--file", file, "--remote"])
}
