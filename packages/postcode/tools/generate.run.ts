// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Compiles this package's two families with `recognize-build --definition` and writes their files:
 *
 *   - `postcode_legacy`, from the legacy-formats table.
 *   - `postal`, from every country's postcode syntax.
 *
 *   For each family `<id>`:
 *
 *   - `data/definitions/<id>.definition.json`, the family definition.
 *   - `data/ir/<id>.json`, the compiled family's IR.
 *   - `data/artifacts/<id>.rca1`, the artifact.
 *   - `data/manifests/<id>.json` and `data/reports/<id>.compiler-report.json`.
 *   - `lib/recognizer/<id>.generated.ts` and `lib/recognizer/artifacts/<id>.generated.ts`,
 *     the family's declarations and its artifact as hexadecimal text.
 *
 *   The `postal` family also writes `data/fixtures/postal-overlap-witnesses.json`, the shortest string
 *   each declared overlapping pair shares, and the shared-language groups it was generated from.
 *
 *   The `postal` definition is built in three compiler runs, because the compiler
 *   owns two answers a generator mustn't guess.
 *   The first run compiles one shape for each country's bare form and each prefixed country's
 *   printed form, and its equivalence analysis decides which countries share a shape.
 *
 *   The second compiles the grouped definition with no overlap declared and lists every
 *   pair that shares a string, and the generator declares each pair on one side.
 *   The third compiles the final definition, where an undeclared overlap is a build error.
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

import {
	DEFINITION_FILE as LEGACY_DEFINITION_FILE,
	FAMILY_ID as LEGACY_ID,
	legacyDefinition,
} from "#tools/legacy-definition"
import {
	DEFINITION_FILE as POSTAL_DEFINITION_FILE,
	FAMILY_ID as POSTAL_ID,
	POSTAL_DENSE_BYTES,
	type DefinitionDocument,
	type ReportedOverlap,
	equivalenceGroups,
	postalDefinition,
	postalProbeDefinition,
	postalShapeID,
} from "#tools/postal/definition"

const { values } = parseArguments({ options: { check: { type: "boolean", default: false } } })
const postcode = (...segments: string[]): string => workspacePath("postcode", ...segments).toString()
const BINARY = repoRootPath("target", "release", "recognize-build").toString()

await runFile("cargo", ["build", "--release", "--locked", "-p", "recognize-build"], {
	cwd: workspacePath("recognizer"),
})

await using scratch = await temporaryDirectory("postcode-generate-")
const built = scratch.path.toString()

// effect-loads: oxfmt.config.ts
const { default: formatConfig } = (await import(repoRootPath("oxfmt.config.ts").toString())) as {
	default: FormatConfig
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

/**
 * Runs `recognize-build` and rethrows a refusal with the diagnostics it printed.
 */
async function build(args: string[]): Promise<string> {
	const printed = await runFile(BINARY, args).catch((error: { stderr?: string }) => {
		console.error(error.stderr ?? String(error))

		throw new Error("recognize-build refused the family definition", { cause: error })
	})

	return printed.stdout
}

/**
 * Writes one definition to the scratch directory and returns its path.
 */
async function stageDefinition(document: DefinitionDocument, file: string): Promise<string> {
	const path = `${built}/${file}`

	await writeLocalTextFile(prettyJSON(document), path)

	return path
}

/**
 * The overlapping pairs the compiler finds for a definition, none declared.
 */
async function listOverlaps(document: DefinitionDocument, file: string): Promise<ReportedOverlap[]> {
	const path = await stageDefinition(document, file)

	return parseJSONStrict<ReportedOverlap[]>(await build(["--definition", path, "--list-overlaps", `${built}/listing`]))
}

/**
 * Compiles a definition and settles its files.
 */
async function generate(
	family: string,
	definitionFile: string,
	document: DefinitionDocument,
	extra: (out: string) => Promise<void> = async () => {},
	limits: string[] = []
): Promise<void> {
	const definitionPath = await stageDefinition(document, definitionFile)
	const out = `${built}/out-${family}`

	const [written] = parseJSONStrict<Array<{ family: string; hash: string; sha256: string }>>(
		await build([...limits, "--definition", definitionPath, out])
	)

	if (written?.family !== family) {
		throw new Error(`recognize-build wrote ${written?.family ?? "no family"} and not ${family}`)
	}

	const artifact = await readLocalBuffer(`${out}/${family}.rca1`)

	if (sha256Hex(artifact) !== written.sha256) {
		throw new Error(`${family}: the artifact's SHA-256 is not the ${written.sha256} the binary printed`)
	}

	await settle(postcode("data", "artifacts", `${family}.rca1`), artifact)
	await settleFormatted(postcode("data", "definitions", definitionFile), await readLocalTextFile(definitionPath))
	await settleFormatted(postcode("data", "ir", `${family}.json`), await readLocalTextFile(`${out}/${family}.json`))

	await settleFormatted(
		postcode("data", "manifests", `${family}.json`),
		await readLocalTextFile(`${out}/artifacts.json`)
	)

	await settleFormatted(
		postcode("data", "reports", `${family}.compiler-report.json`),
		await readLocalTextFile(`${out}/compiler-report.json`)
	)

	await settleFormatted(
		postcode("lib", "recognize", `${family}.generated.ts`),
		await readLocalTextFile(`${out}/ts/${family}.generated.ts`)
	)

	await settleFormatted(
		postcode("lib", "recognize", "artifacts", `${family}.generated.ts`),
		await readLocalTextFile(`${out}/ts/artifacts/${family}.generated.ts`)
	)

	await extra(out)
}

await generate(LEGACY_ID, LEGACY_DEFINITION_FILE, legacyDefinition())

// The groups come from the compiler's equivalence analysis of one probe shape for each form.
const probe = await listOverlaps(postalProbeDefinition(), "postal_probe.definition.json")
const bare = equivalenceGroups("bare", probe)
const printed = equivalenceGroups("printed", probe)

// Every pair of the grouped definition that shares a string, declared on the side that sorts first.
// A pair with a shape of another family is declared on the postal side, because
// `@mailwoman/recognizer` cannot name a shape of this package.
const ungrouped = await listOverlaps(postalDefinition(bare, printed), POSTAL_DEFINITION_FILE)
const declared = new Map<string, string[]>()

for (const pair of ungrouped) {
	if (pair.declared) continue

	const own = [pair.a, pair.b].filter((side) => side.family === POSTAL_ID)
	const [owner, partner] = own.length === 2 ? [pair.a, pair.b] : [own[0]!, own[0] === pair.a ? pair.b : pair.a]

	declared.set(owner.shape, [...(declared.get(owner.shape) ?? []), partner.shape])
}

for (const [shape, partners] of declared) {
	declared.set(shape, partners.toSorted())
}

await generate(
	POSTAL_ID,
	POSTAL_DEFINITION_FILE,
	postalDefinition(bare, printed, declared),
	async (out) => {
		await settleFormatted(
			postcode("data", "fixtures", "postal-overlap-witnesses.json"),
			await readLocalTextFile(`${out}/overlap-witnesses.json`)
		)

		await settleFormatted(
			postcode("data", "fixtures", "postal-groups.json"),
			prettyJSON({
				bare: bare.map((group) => ({ shape: postalShapeID("bare", group[0]!), countries: group })),
				printed: printed.map((group) => ({ shape: postalShapeID("printed", group[0]!), countries: group })),
			})
		)
	},
	["--dense-bytes", String(POSTAL_DENSE_BYTES)]
)

if (stale) {
	process.exitCode = 1
}
