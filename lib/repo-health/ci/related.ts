/**
 * Selects test files through Vitest's import graph without executing tests.
 */
import { resolvePath, relative } from "path-ts"
import { createVitest } from "vitest/node"

import { isTestFile, readsAnyOf } from "#repo-health/ci/runtime-reads"
import { type CIScope, type CIWorkspace, dataRootReaders } from "#repo-health/ci/scope"

/**
 * Reuses Vitest's transforms across several selections and closes its servers when disposed.
 */
export async function createCIRelatedReader(root: string, config: string) {
	const vitest = await createVitest({ root, config: resolvePath(root, config), watch: false })

	return {
		async read(changed: readonly string[]): Promise<string[]> {
			vitest.config.related = changed.map((file) => resolvePath(root, file))
			const specifications = await vitest.getRelevantTestSpecifications()

			return [...new Set(specifications.map((specification) => relative(root, specification.moduleId)))].toSorted()
		},
		async [Symbol.asyncDispose](): Promise<void> {
			await vitest.close()
		},
	}
}

const MODULE_FILE = /\.[cm]?[jt]sx?$/u

/**
 * Narrows a workspace selection to the tests a change reaches, through imports or through runtime reads.
 *
 * A test is kept when Vitest's import graph reaches a changed file, or
 * when the test itself may read a changed file at runtime.
 * Each non-test module in an affected workspace that may read a changed file counts
 * as changed too, so the tests importing that module are kept.
 *
 * That module may be a fixture reader, or a library function whose default argument is the repository root.
 *
 * A module that may read any file is kept on every change.
 * The narrowed selection stays inside the workspace selection whenever a non-module file changed.
 */
export async function selectRelatedCIScope(
	scope: CIScope,
	workspaces: readonly CIWorkspace[],
	changed: readonly string[],
	readRelated: (changed: readonly string[], config: string) => Promise<string[]>
): Promise<CIScope> {
	const inputs = changed.filter(
		(file) => !file.endsWith(".md") && !file.startsWith(".agents/") && file !== "typos.toml"
	)

	if (scope.full || (!scope.fast && !scope.slow)) return scope

	const readers = workspaces.flatMap((workspace) => Object.entries(workspace.runtimeReads ?? {}))
	const affected = scope.affected
	const inAffected = (file: string): boolean => affected.some((directory) => file.startsWith(`${directory}/`))
	const nonModules = inputs.filter((file) => !MODULE_FILE.test(file))

	const readingModules = readers
		.filter(([file, reads]) => !isTestFile(file) && inAffected(file) && readsAnyOf(reads, inputs, affected))
		.map(([file]) => file)

	const related = [...new Set([...inputs, ...readingModules])].toSorted()

	const [fast, slow] = await Promise.all([
		readRelated(related, "vitest.fast.config.ts"),
		readRelated(related, "vitest.slow.config.ts"),
	])

	const readingTests = new Set(
		readers.filter(([file, reads]) => isTestFile(file) && readsAnyOf(reads, inputs, affected)).map(([file]) => file)
	)

	const narrow = (fromGraph: readonly string[], selected: readonly string[]): string[] => {
		const kept = [...new Set([...fromGraph, ...selected.filter((file) => readingTests.has(file))])]
		const bound = new Set(selected)

		return (nonModules.length ? kept.filter((file) => bound.has(file)) : kept).toSorted()
	}

	const fastFiles = narrow(fast, scope.fastFiles)
	const slowFiles = narrow(slow, scope.slowFiles)

	return {
		...scope,
		fastFiles,
		slowFiles,
		dataRootFiles: dataRootReaders(workspaces, [...fastFiles, ...slowFiles]),
		fast: fastFiles.length > 0,
		slow: slowFiles.length > 0,
	}
}

/**
 * Returns the tests whose module graph reaches a changed file.
 *
 * Vitest also accounts for setup files, configuration imports, and snapshots.
 */
export async function readRelatedCITests(root: string, changed: readonly string[], config: string): Promise<string[]> {
	await using reader = await createCIRelatedReader(root, config)

	return await reader.read(changed)
}
