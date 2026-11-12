// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Builds `crates/deflate64-wasm` for `wasm32-unknown-unknown` and writes the
 *   result to `wasm/deflate64.wasm`.
 *
 *   With `--check`, the tool builds without writing.
 *   It exits non-zero when the build's SHA-256 differs from the committed binary's.
 *
 *   Usage: `node packages/core/tools/build-deflate64-wasm.run.ts [--check]`
 */

import { statPath } from "#fs/readers/stat"
import { replaceFileAtomically } from "#fs/writers"
import { sha256File } from "#hash"
import { repoRootPath, workspacePath } from "#paths"
import { runFile } from "#process"
import { parseArguments } from "#scripting/arguments"

const { values } = parseArguments({ options: { check: { type: "boolean", default: false } } })

const workspace = workspacePath("core")
const built = repoRootPath("target", "wasm32-unknown-unknown", "release", "deflate64_wasm.wasm")
const committed = workspacePath("core", "wasm", "deflate64.wasm")

await runFile(
	"cargo",
	["build", "--release", "--locked", "--target", "wasm32-unknown-unknown", "-p", "deflate64-wasm"],
	{ cwd: workspace }
)

const builtDigest = await sha256File(built)
const { size } = await statPath(built)

if (values.check) {
	const committedDigest = await sha256File(committed)

	if (committedDigest === builtDigest) {
		console.log(`wasm/deflate64.wasm matches the build: ${builtDigest} (${size} bytes)`)
	} else {
		console.error(`wasm/deflate64.wasm is stale: committed ${committedDigest}, built ${builtDigest} (${size} bytes)`)

		process.exitCode = 1
	}
} else {
	await replaceFileAtomically(built, committed)

	console.log(`wrote wasm/deflate64.wasm: ${builtDigest} (${size} bytes)`)
}
