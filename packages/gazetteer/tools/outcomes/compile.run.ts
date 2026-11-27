// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Compiles the outcome definitions clone and generates
 *   `@mailwoman/gazetteer/whosonfirst/outcomes/kinds` from it.
 *
 *   Usage: node packages/gazetteer/tools/outcomes/compile.run.ts [--repos-root <dir>]
 *
 *   The compiled spec is written to the clone's `data/outcomes-spec-latest.json`.
 *   When that file then differs from the clone's committed copy, the command stops
 *   and asks for a commit in the clone, because the generated module pins a committed revision.
 *
 *   Otherwise it writes the module pinned to the clone's `HEAD`.
 */

import { wofReposPath } from "@mailwoman/core/data-root"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { repoRootPath } from "@mailwoman/core/paths"
import { gitSync } from "@mailwoman/core/repo/git"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { runFileSync } from "@mailwoman/core/scripting/process"
import { resolvePath } from "path-ts"

import { outcomeKindsModulePath, renderOutcomeKindsModule } from "#tools/outcomes/render"
import { compileOutcomeSpec, OutcomeCompileError, serializeOutcomeSpec } from "#whosonfirst/outcomes/compile"
import { OUTCOMES_SPEC_FILE } from "#whosonfirst/outcomes/definition"
import { readOutcomeDefinitions, readPinnedOutcomeSpec, requireOutcomesRepo } from "#whosonfirst/outcomes/read"

const { values } = parseArguments({ options: { "repos-root": { type: "string" } } })
const reposRoot = values["repos-root"] ? resolvePath(values["repos-root"]) : wofReposPath()
const repo = await requireOutcomesRepo(reposRoot)

const input = await readOutcomeDefinitions(reposRoot)
let spec: ReturnType<typeof compileOutcomeSpec>

try {
	spec = compileOutcomeSpec(input)
} catch (error) {
	if (!(error instanceof OutcomeCompileError)) throw error

	console.error(`${repo} doesn't compile; ${error.refusals.length} refusals:`)

	for (const refusal of error.refusals) {
		console.error(`  ${refusal}`)
	}

	process.exit(1)
}

const text = serializeOutcomeSpec(spec)

await writeLocalTextFile(text, resolvePath(repo, OUTCOMES_SPEC_FILE))

const status = gitSync(["status", "--porcelain"], { cwd: repo })

if (status) {
	console.error(`${repo} has uncommitted changes, including the compiled spec when it moved:\n${status}`)
	console.error("Commit them in the clone, then run this command again to pin the module to that revision.")

	process.exit(1)
}

const { pin } = readPinnedOutcomeSpec(repo)

await writeLocalTextFile(renderOutcomeKindsModule(spec, pin), outcomeKindsModulePath())
runFileSync("yarn", ["oxfmt", outcomeKindsModulePath()], { cwd: repoRootPath(), stdio: "inherit" })

console.log(
	`wrote ${outcomeKindsModulePath()}: ${spec.definitions.length} outcome kinds at ${pin.revision} (sha256 ${pin.sha256})`
)
