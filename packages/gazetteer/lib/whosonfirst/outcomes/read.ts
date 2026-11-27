// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { sha256Hex } from "@mailwoman/core/crypto/hash"
import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { gitSync } from "@mailwoman/core/repo/git"
import { parseJSONStrict } from "@mailwoman/core/values/json"
import { resolvePath, type PathBuilderLike } from "path-ts"
import { Globerator } from "spliterator/node/fs"

import { resolveWOFRepo } from "#whosonfirst/extract-repo"
import { OUTCOMES_REPO, OUTCOMES_SPEC_FILE, type OutcomeDefinitionsInput } from "#whosonfirst/outcomes/definition"
import type {
	CompiledOutcomeSpec,
	OutcomeDefinition,
	OutcomeRegistryRow,
	OutcomeSpecPin,
} from "#whosonfirst/outcomes/spec"
import { PLACETYPES_REPO } from "#whosonfirst/placetypes/Placetype"

async function requireRepo(reposRoot: PathBuilderLike, name: string): Promise<string> {
	const repo = await resolveWOFRepo(reposRoot, name)

	if (!repo) throw new Error(`${name} isn't cloned under ${reposRoot.toString()}.`)

	return repo
}

/**
 * The outcome definitions clone under a repositories root, or an error naming the missing clone.
 */
export function requireOutcomesRepo(reposRoot: PathBuilderLike): Promise<string> {
	return requireRepo(reposRoot, OUTCOMES_REPO.name)
}

/**
 * Read every input the compile step takes from the outcomes clone and the placetypes clone.
 */
export async function readOutcomeDefinitions(reposRoot: PathBuilderLike): Promise<OutcomeDefinitionsInput> {
	const repo = await requireOutcomesRepo(reposRoot)
	const placetypesRepo = await requireRepo(reposRoot, PLACETYPES_REPO.name)

	const definitions: OutcomeDefinition[] = []

	for await (const path of Globerator.from("*.json", { cwd: resolvePath(repo, "outcomes"), absolute: true })) {
		const definition = await readLocalJSONFile<OutcomeDefinition>(path)
		const fileName = path.toString().split("/").at(-1)

		if (fileName !== `${definition["mw:name"]}.json`) {
			throw new Error(`${path.toString()} holds the definition of ${definition["mw:name"]}; a file is named by its id.`)
		}

		definitions.push(definition)
	}

	const placetypes: string[] = []

	for await (const path of Globerator.from("*.json", {
		cwd: resolvePath(placetypesRepo, "placetypes"),
		absolute: true,
	})) {
		placetypes.push((await readLocalJSONFile<{ "wof:name": string }>(path))["wof:name"])
	}

	const specPath = resolvePath(repo, OUTCOMES_SPEC_FILE)

	return {
		definitions,
		registry: await readLocalJSONFile<OutcomeRegistryRow[]>(resolvePath(repo, "registry.json")),
		exemptions: await readLocalJSONFile<Record<string, string>>(resolvePath(repo, "exemptions", "placetypes.json")),
		placetypes: placetypes.toSorted(),
		previousRegistry: (await pathExists(specPath))
			? (await readLocalJSONFile<CompiledOutcomeSpec>(specPath)).registry
			: null,
	}
}

/**
 * The compiled spec committed at the clone's `HEAD`, with the pin a database built from it records.
 *
 * @throws When the clone's compiled spec has uncommitted changes, because a pin records a commit.
 */
export function readPinnedOutcomeSpec(repo: string): { spec: CompiledOutcomeSpec; pin: OutcomeSpecPin } {
	if (gitSync(["status", "--porcelain", "--", OUTCOMES_SPEC_FILE], { cwd: repo })) {
		throw new Error(`${repo} has an uncommitted ${OUTCOMES_SPEC_FILE}; commit it so a build can pin its revision.`)
	}

	const revision = gitSync(["rev-parse", "HEAD"], { cwd: repo })
	const text = gitSync(["show", `${revision}:${OUTCOMES_SPEC_FILE}`], { cwd: repo, trim: false })

	return { spec: parseJSONStrict<CompiledOutcomeSpec>(text), pin: { revision, sha256: sha256Hex(text) } }
}
