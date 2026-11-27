// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { resolvePath, type PathBuilderLike } from "path-ts"
import { Globerator } from "spliterator/node/fs"

import { resolveWOFRepo } from "#whosonfirst/extract-repo"
import {
	type CompiledOutcomeSpec,
	OUTCOMES_REPO,
	OUTCOMES_SPEC_FILE,
	type OutcomeDefinition,
	type OutcomeDefinitionsInput,
	type OutcomeRegistryRow,
} from "#whosonfirst/outcomes/definition"
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
 * Read the compiled spec the clone holds.
 */
export async function readCompiledOutcomeSpec(reposRoot: PathBuilderLike): Promise<CompiledOutcomeSpec> {
	return readLocalJSONFile<CompiledOutcomeSpec>(resolvePath(await requireOutcomesRepo(reposRoot), OUTCOMES_SPEC_FILE))
}
