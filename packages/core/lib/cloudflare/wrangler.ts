/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   R2 uploads through `wrangler r2 object put` and D1 statements through `wrangler d1 execute`. Wrangler reads
 *   `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` from the environment. `wrangler` is an optional peer
 *   dependency of this package, so a caller installs it.
 */

import { resolvePath } from "path-ts"

import { statPath } from "#fs/readers/stat"
import { parseJSONStrict } from "#json"
import { resolvePackageDirectory } from "#module/resolvers"
import { isPresent } from "#objects"
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

	await runFile("node", [wranglerBin(), "r2", "object", "put", `${bucket}/${key}`, "--file", file, "--remote"])
}

function wranglerBin(): string {
	return resolvePath(resolvePackageDirectory("wrangler"), "bin", "wrangler.js").toString()
}

/**
 * Run one SQL statement against a remote D1 database and answer the rows it changed.
 *
 * `config` is the `wrangler.toml` that binds `database`.
 *
 * @throws When wrangler exits nonzero, or answers JSON without a `changes` count to read.
 */
export async function executeD1WithWrangler({
	database,
	config,
	command,
}: {
	database: string
	config: string
	command: string
}): Promise<{ changes: number }> {
	// With `--json`, wrangler writes an API failure as JSON on stdout.
	// The thrown message includes that output, so the operator reads the API's stated cause.
	const { stdout } = await runFile("node", [
		wranglerBin(),
		"d1",
		"execute",
		database,
		"--remote",
		"--json",
		"--config",
		config,
		"--command",
		command,
	]).catch((error: unknown) => {
		const output = error as { stdout?: string; stderr?: string }
		const detail = [output.stdout, output.stderr].filter(isPresent).join("\n").trim().slice(0, 1000)

		throw new Error(`wrangler d1 execute ${database} failed${detail ? `:\n${detail}` : ""}`, { cause: error })
	})

	const results = parseJSONStrict<Array<{ meta?: { changes?: number } }>>(stdout)
	const changes = results[0]?.meta?.changes

	if (typeof changes !== "number") {
		throw new TypeError(`wrangler d1 execute ${database} answered no changes count: ${stdout.slice(0, 200)}`)
	}

	return { changes }
}
