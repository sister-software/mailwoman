// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Compiles the `postcode_legacy` family from the legacy-formats table with
 *   `recognize-build --definition` and writes its files into this package:
 *
 *   - `data/definitions/postcode_legacy.definition.json`, the family definition built from the table.
 *   - `data/ir/postcode_legacy.json`, the compiled family's IR.
 *   - `data/artifacts/postcode_legacy.rca1`, the artifact.
 *   - `data/manifests/artifacts.json` and `data/reports/compiler-report.json`.
 *   - `lib/recognize/postcode_legacy.generated.ts` and `lib/recognize/artifacts/postcode_legacy.generated.ts`,
 *     the family's declarations and its artifact as hexadecimal text.
 *
 *   A refused definition prints each diagnostic with the definition's file and line,
 *   and the tool exits non-zero without writing.
 *
 *   `--check` generates into a scratch directory and exits non-zero when a committed file differs.
 *
 *   Usage: `node packages/postcode/tools/generate.run.ts [--check]`
 */

import { readLocalBuffer, readLocalTextFile } from "@mailwoman/core/fs/readers"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalFile, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { sha256Hex } from "@mailwoman/core/hash"
import { parseJSONStrict, prettyJSON } from "@mailwoman/core/json"
import { repoRootPath, workspacePath } from "@mailwoman/core/paths"
import { runFile } from "@mailwoman/core/process"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { type FormatConfig, format } from "oxfmt"

import { DEFINITION_FILE, FAMILY_ID, legacyDefinition } from "#tools/legacy-definition"

const { values } = parseArguments({ options: { check: { type: "boolean", default: false } } })
const postcode = (...segments: string[]): string => workspacePath("postcode", ...segments).toString()

await runFile("cargo", ["build", "--release", "--locked", "-p", "recognize-build"], {
	cwd: workspacePath("recognize"),
})

await using scratch = await temporaryDirectory("postcode-generate-")
const built = scratch.path.toString()
const definitionPath = `${built}/${DEFINITION_FILE}`

await writeLocalTextFile(prettyJSON(legacyDefinition()), definitionPath)

// A refused definition exits 1 and prints `file:line: kind: message` diagnostics on stderr.
const printed = await runFile(repoRootPath("target", "release", "recognize-build").toString(), [
	"--definition",
	definitionPath,
	`${built}/out`,
]).catch((error: { stderr?: string }) => {
	console.error(error.stderr ?? String(error))

	throw new Error("recognize-build refused the family definition", { cause: error })
})

// effect-loads: oxfmt.config.ts
const { default: formatConfig } = (await import(repoRootPath("oxfmt.config.ts").toString())) as {
	default: FormatConfig
}

const [written] = parseJSONStrict<Array<{ family: string; hash: string; sha256: string }>>(printed.stdout)

if (written?.family !== FAMILY_ID) {
	throw new Error(`recognize-build wrote ${written?.family ?? "no family"} and not ${FAMILY_ID}`)
}

let stale = 0

/**
 * Writes `bytes` to `target`.
 *
 * Under `--check` it counts the file as stale when it differs.
 */
async function settle(target: string, bytes: Buffer | string): Promise<void> {
	const wanted = Buffer.from(bytes)

	if (values.check) {
		const committed = await readLocalBuffer(target).catch(() => null)

		if (!committed || !committed.equals(wanted)) {
			console.error(`${target} differs from the generator's output`)

			stale++
		}
	} else {
		await writeLocalFile(wanted, target)

		console.log(`wrote ${target}`)
	}
}

/**
 * Settles a text file as the repository's formatter writes it.
 */
async function settleFormatted(target: string, text: string): Promise<void> {
	const formatted = await format(target, text, formatConfig)

	if (formatted.errors.length) {
		throw new Error(`oxfmt could not format ${target}: ${formatted.errors.map((error) => error.message).join("; ")}`)
	}

	await settle(target, formatted.code)
}

const artifact = await readLocalBuffer(`${built}/out/${FAMILY_ID}.rca1`)

if (sha256Hex(artifact) !== written.sha256) {
	throw new Error(`${FAMILY_ID}: the artifact's SHA-256 is not the ${written.sha256} the binary printed`)
}

await settle(postcode("data", "artifacts", `${FAMILY_ID}.rca1`), artifact)
await settleFormatted(postcode("data", "definitions", DEFINITION_FILE), await readLocalTextFile(definitionPath))

await settleFormatted(
	postcode("data", "ir", `${FAMILY_ID}.json`),
	await readLocalTextFile(`${built}/out/${FAMILY_ID}.json`)
)

await settleFormatted(
	postcode("data", "manifests", "artifacts.json"),
	await readLocalTextFile(`${built}/out/artifacts.json`)
)

await settleFormatted(
	postcode("data", "reports", "compiler-report.json"),
	await readLocalTextFile(`${built}/out/compiler-report.json`)
)

await settleFormatted(
	postcode("lib", "recognize", `${FAMILY_ID}.generated.ts`),
	await readLocalTextFile(`${built}/out/ts/${FAMILY_ID}.generated.ts`)
)

await settleFormatted(
	postcode("lib", "recognize", "artifacts", `${FAMILY_ID}.generated.ts`),
	await readLocalTextFile(`${built}/out/ts/artifacts/${FAMILY_ID}.generated.ts`)
)

if (stale) {
	process.exitCode = 1
}
