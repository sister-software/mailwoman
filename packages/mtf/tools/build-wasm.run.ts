/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Builds `crates/mtf-wasm` for `wasm32-unknown-unknown` and writes the result to `wasm/mtf.wasm`.
 *
 *   With `--check`, the tool builds without writing.
 *   It exits non-zero when the build's SHA-256 differs from the committed binary's.
 *
 *   Usage: `node packages/mtf/tools/build-wasm.run.ts [--check]`
 */

import { statPath } from "@mailwoman/core/fs/readers/stat"
import { replaceFileAtomically } from "@mailwoman/core/fs/writers"
import { sha256File } from "@mailwoman/core/hash"
import { repoRootPath, workspacePath } from "@mailwoman/core/paths"
import { runFile } from "@mailwoman/core/process"
import { parseArguments } from "@mailwoman/core/scripting/arguments"

const { values } = parseArguments({ options: { check: { type: "boolean", default: false } } })

const workspace = workspacePath("mtf")
const built = repoRootPath("target", "wasm32-unknown-unknown", "release", "mtf_wasm.wasm")
const committed = workspacePath("mtf", "wasm", "mtf.wasm")

await runFile("cargo", ["build", "--release", "--locked", "--target", "wasm32-unknown-unknown", "-p", "mtf-wasm"], {
	cwd: workspace,
})

const builtDigest = await sha256File(built)
const { size } = await statPath(built)

if (values.check) {
	const committedDigest = await sha256File(committed)

	if (committedDigest === builtDigest) {
		console.log(`wasm/mtf.wasm matches the build: ${builtDigest} (${size} bytes)`)
	} else {
		console.error(`wasm/mtf.wasm is stale: committed ${committedDigest}, built ${builtDigest} (${size} bytes)`)

		process.exitCode = 1
	}
} else {
	await replaceFileAtomically(built, committed)

	console.log(`wrote wasm/mtf.wasm: ${builtDigest} (${size} bytes)`)
}
