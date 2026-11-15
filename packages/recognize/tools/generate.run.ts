// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Writes each grammar family's intermediate representation to `data/ir/<family>.json`,
 *   its compiled artifact to `data/artifacts/<family>.rca1`, and the build manifest to
 *   `data/manifests/artifacts.json`, all with `crates/recognize-build`.
 *
 *   The build binary validates and compiles every family first.
 *   A grammar that fails validation or exceeds a compiler limit prints each diagnostic
 *   with the grammar's source file and line, and this tool exits non-zero without writing.
 *
 *   The artifacts sit under `data/artifacts` beside the IR.
 *   The registry commits its artifacts beside the tool that generates them the same way.
 *   They're binary, so no formatter touches them.
 *
 *   Usage: `node packages/recognize/tools/generate.run.ts [--check]`
 *
 *   The binary writes the IR and the manifest with serde_json's pretty printer.
 *   This tool formats each of those files with the repository's oxfmt.
 *
 *   `--check` generates into a scratch directory and formats the same way.
 *   It exits non-zero when a committed file differs.
 */

import { readLocalBuffer, readLocalTextFile } from "@mailwoman/core/fs/readers"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalFile } from "@mailwoman/core/fs/writers"
import { sha256Hex } from "@mailwoman/core/hash"
import { parseJSONStrict } from "@mailwoman/core/json"
import { repoRootPath, workspacePath } from "@mailwoman/core/paths"
import { runFile } from "@mailwoman/core/process"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { type FormatConfig, format } from "oxfmt"

import { IR_FORMAT, IR_VERSION } from "#index"

const { values } = parseArguments({ options: { check: { type: "boolean", default: false } } })
const recognize = (...segments: string[]): string => workspacePath("recognize", ...segments)

await runFile("cargo", ["build", "--release", "--locked", "-p", "recognize-build"], { cwd: workspacePath("recognize") })

await using scratch = await temporaryDirectory("recognize-generate-")
const built = scratch.path.toString()
const binary = repoRootPath("target", "release", "recognize-build")

// A refused grammar exits 1 and prints `file:line: kind: message` diagnostics on stderr.
const printed = await runFile(binary, [built]).catch((error: { stderr?: string }) => {
	console.error(error.stderr ?? String(error))

	throw new Error("recognize-build refused a grammar", { cause: error })
})

let stale = 0

// effect-loads: oxfmt.config.ts
const { default: formatConfig } = (await import(repoRootPath("oxfmt.config.ts").toString())) as {
	default: FormatConfig
}

// The binary prints a JSON array of `{ family, hash, sha256 }` for each family it wrote.
// `hash` is the IR hash and `sha256` is the artifact's.
const written = parseJSONStrict<Array<{ family: string; hash: string; sha256: string }>>(printed.stdout)

if (!written.length) {
	throw new Error("recognize-build wrote no family")
}

/**
 * Writes `bytes` to `target`.
 *
 * Under `--check` it counts the file as stale when it differs.
 */
async function settle(target: string, bytes: Buffer | string, label: string): Promise<void> {
	const wanted = Buffer.from(bytes)

	if (values.check) {
		const committed = await readLocalBuffer(target).catch(() => null)

		if (!committed || !committed.equals(wanted)) {
			console.error(`${target} differs from the generator's output`)

			stale++
		}
	} else {
		await writeLocalFile(wanted, target)

		console.log(`wrote ${target} ${label}`)
	}
}

for (const { family, hash, sha256 } of written) {
	// The artifact is binary and no formatter touches it, so the committed bytes are the binary's bytes.
	const artifact = await readLocalBuffer(`${built}/${family}.rca1`)

	if (sha256Hex(artifact) !== sha256) {
		throw new Error(`${family}: the artifact's SHA-256 is not the ${sha256} the binary printed`)
	}

	await settle(recognize("data", "artifacts", `${family}.rca1`), artifact, sha256)

	const generated = await readLocalTextFile(`${built}/${family}.json`)
	const target = recognize("data", "ir", `${family}.json`)
	const identity = parseJSONStrict<{ format: string; version: number; hash: string }>(generated)

	if (identity.format !== IR_FORMAT || identity.version !== IR_VERSION || identity.hash !== hash) {
		throw new Error(
			`${family}: the binary wrote ${identity.format} v${identity.version} ${identity.hash}, ` +
				`expected ${IR_FORMAT} v${IR_VERSION} ${hash}`
		)
	}

	// The committed text is the binary's text as the repository's formatter writes it, so `yarn lint:oxfmt` accepts it.
	const formatted = await format(target, generated, formatConfig)

	if (formatted.errors.length) {
		throw new Error(`oxfmt could not format ${target}: ${formatted.errors.map((error) => error.message).join("; ")}`)
	}

	await settle(target, formatted.code, hash)
}

// The manifest records each artifact's byte size, backend, state count and hashes, as the registry's does.
const manifestTarget = recognize("data", "manifests", "artifacts.json")
const manifest = await format(manifestTarget, await readLocalTextFile(`${built}/artifacts.json`), formatConfig)

if (manifest.errors.length) {
	throw new Error(
		`oxfmt could not format ${manifestTarget}: ${manifest.errors.map((error) => error.message).join("; ")}`
	)
}

await settle(manifestTarget, manifest.code, "manifest")

if (stale) {
	process.exitCode = 1
}
