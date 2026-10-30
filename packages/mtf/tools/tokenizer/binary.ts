/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The two native programs the tokenizer tools run: `mtf-tokenizer`, built from `crates/mtf-tools`, and
 *   SentencePiece v0.2.2's `spm_train`.
 *
 *   `mtf-tokenizer` is a binary rather than a Node addon. Each tool calls it a handful of times over files, so a
 *   process per call costs milliseconds. A binary also builds without an addon toolchain, a per-platform artifact or ABI
 *   matching against Node. Cargo builds it on first use under the `tools` profile.
 *
 *   `spm_train` is built from the google/sentencepiece tag the runtime and the Python wheel were built from, with the
 *   CMake recipe of `packages/sentencepiece-wasm/build.sh` minus emscripten. The checkout and build live under the
 *   cache root, outside the repository.
 */

import { cacheRootPath } from "@mailwoman/core/data-root"
import { isFile } from "@mailwoman/core/fs/readers/stat"
import { makeDirectories } from "@mailwoman/core/fs/writers"
import { git, gitHead } from "@mailwoman/core/git"
import { parseJSONStrict } from "@mailwoman/core/json"
import { repoRootPath, workspacePath } from "@mailwoman/core/paths"
import { runFile } from "@mailwoman/core/process"

/**
 * The SentencePiece release every tokenizer is trained with, and the commit its tag names.
 */
export const SENTENCEPIECE = {
	version: "0.2.2",
	tag: "v0.2.2",
	commit: "e0cce7d37b065b5140349dbe12c6bcf6192fdd78",
} as const

/**
 * Child output can be a full model inspection, so the buffer is far above Node's 1 MB default.
 */
const OUTPUT_LIMIT = 1 << 30

let mtfTokenizerBuild: Promise<string> | null = null

/**
 * The path of a current `mtf-tokenizer` build, building it the first time a process asks.
 */
export function mtfTokenizerBinary(): Promise<string> {
	mtfTokenizerBuild ??= (async () => {
		await runFile("cargo", ["build", "--profile", "tools", "--locked", "-p", "mtf-tools"], {
			cwd: workspacePath("mtf"),
			maxBuffer: OUTPUT_LIMIT,
		})

		return repoRootPath("target", "tools", "mtf-tokenizer")
	})()

	return mtfTokenizerBuild
}

/**
 * Run one `mtf-tokenizer` command and parse the JSON it prints.
 */
export async function runMTFTokenizer<T>(args: readonly string[]): Promise<T> {
	const { stdout } = await runFile(await mtfTokenizerBinary(), args, { maxBuffer: OUTPUT_LIMIT })

	return parseJSONStrict<T>(stdout)
}

/**
 * The `spm_train` to run: `explicit` when given, otherwise a build of {@linkcode SENTENCEPIECE}
 * under the cache root, cloned and compiled the first time.
 */
export async function spmTrainBinary(explicit?: string | null): Promise<string> {
	if (explicit) {
		if (!(await isFile(explicit))) throw new Error(`--spm-train ${explicit} is not a file`)

		return explicit
	}

	const root = cacheRootPath(`sentencepiece-${SENTENCEPIECE.tag}`)
	const source = `${root}/src`
	const build = `${root}/build`
	const binary = `${build}/src/spm_train`

	if (await isFile(binary)) return binary

	await makeDirectories(root)

	if (!(await isFile(`${source}/CMakeLists.txt`))) {
		await git(
			[
				"clone",
				"--quiet",
				"--depth",
				"1",
				"--branch",
				SENTENCEPIECE.tag,
				"https://github.com/google/sentencepiece.git",
				source,
			],
			root
		)
	}

	const head = await gitHead(source)

	if (head !== SENTENCEPIECE.commit) {
		throw new Error(`${source} is at ${head}, not ${SENTENCEPIECE.tag} (${SENTENCEPIECE.commit})`)
	}

	await runFile(
		"cmake",
		["-S", source, "-B", build, "-DCMAKE_BUILD_TYPE=Release", "-DSPM_ENABLE_SHARED=OFF", "-DSPM_ENABLE_TCMALLOC=OFF"],
		{ maxBuffer: OUTPUT_LIMIT }
	)

	await runFile("cmake", ["--build", build, "-j", "4", "--target", "spm_train"], { maxBuffer: OUTPUT_LIMIT })

	return binary
}
