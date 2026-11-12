// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Builds `crates/registry-wasm` for `wasm32-unknown-unknown` twice, once with `simd128`
 *   and once without, and writes `wasm/registry-simd.wasm` and `wasm/registry.wasm`.
 *
 *   The two builds use separate target directories, because a `RUSTFLAGS` change would
 *   otherwise invalidate every crate in the shared target directory.
 *
 *   With `--check`, the tool builds without writing and exits non-zero
 *   when a build's SHA-256 differs from the committed binary's.
 *
 *   Usage: `node packages/registry/tools/build-wasm.run.ts [--check]`
 */

import { statPath } from "@mailwoman/core/fs/readers/stat"
import { replaceFileAtomically } from "@mailwoman/core/fs/writers"
import { sha256File } from "@mailwoman/core/hash"
import { repoRootPath, workspacePath } from "@mailwoman/core/paths"
import { runFile } from "@mailwoman/core/process"
import { parseArguments } from "@mailwoman/core/scripting/arguments"

const { values } = parseArguments({ options: { check: { type: "boolean", default: false } } })

const workspace = workspacePath("registry")

/**
 * The two builds.
 *
 * The simd build passes its target feature through cargo's `--config`,
 * so the environment stays as the caller set it.
 */
const VARIANTS = [
	{ file: "registry.wasm", targetDir: repoRootPath("target", "registry-wasm"), config: [] },
	{
		file: "registry-simd.wasm",
		targetDir: repoRootPath("target", "registry-wasm-simd"),
		config: ["--config", 'build.rustflags=["-C","target-feature=+simd128"]'],
	},
] as const

for (const variant of VARIANTS) {
	await runFile(
		"cargo",
		[
			"build",
			"--release",
			"--locked",
			"--target",
			"wasm32-unknown-unknown",
			"-p",
			"registry-wasm",
			"--target-dir",
			variant.targetDir,
			...variant.config,
		],
		{ cwd: workspace }
	)

	const built = `${variant.targetDir}/wasm32-unknown-unknown/release/registry_wasm.wasm`
	const committed = workspacePath("registry", "wasm", variant.file)
	const builtDigest = await sha256File(built)
	const { size } = await statPath(built)

	if (values.check) {
		const committedDigest = await sha256File(committed)

		if (committedDigest === builtDigest) {
			console.log(`wasm/${variant.file} matches the build: ${builtDigest} (${size} bytes)`)
		} else {
			console.error(`wasm/${variant.file} is stale: committed ${committedDigest}, built ${builtDigest} (${size} bytes)`)

			process.exitCode = 1
		}
	} else {
		await replaceFileAtomically(built, committed)

		console.log(`wrote wasm/${variant.file}: ${builtDigest} (${size} bytes)`)
	}
}
