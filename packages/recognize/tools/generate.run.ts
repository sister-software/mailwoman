// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Writes each grammar family's intermediate representation to `data/ir/<family>.json`
 *   with `crates/recognize-build`.
 *
 *   The build binary validates every family first.
 *   A grammar that fails validation prints each diagnostic with the grammar's source file
 *   and line, and this tool exits non-zero without writing.
 *
 *   Usage: `node packages/recognize/tools/generate.run.ts [--check]`
 *
 *   The binary writes the IR with serde_json's pretty printer, and this tool
 *   formats each file with the repository's oxfmt.
 *   `--check` generates into a scratch directory, formats the same way,
 *   and exits non-zero when a committed file differs.
 */

import { readLocalBuffer, readLocalTextFile } from "@mailwoman/core/fs/readers"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalFile } from "@mailwoman/core/fs/writers"
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

// The binary prints a JSON array of `{ family, hash }` for each family it wrote.
const written = parseJSONStrict<Array<{ family: string; hash: string }>>(printed.stdout)

if (!written.length) {
	throw new Error("recognize-build wrote no family")
}

for (const { family, hash } of written) {
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

	if (values.check) {
		const committed = await readLocalBuffer(target).catch(() => null)

		if (!committed || !committed.equals(Buffer.from(formatted.code))) {
			console.error(`${target} differs from the generator's output`)

			stale++
		}
	} else {
		await writeLocalFile(formatted.code, target)

		console.log(`wrote ${target} ${hash}`)
	}
}

if (stale) {
	process.exitCode = 1
}
