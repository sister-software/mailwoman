/**
 * Selects test files through Vitest's import graph without executing tests.
 */
import { resolvePath, relative } from "path-ts"
import { createVitest } from "vitest/node"

import type { CIScope, CIWorkspace } from "#repo-health/ci-scope"

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

/**
 * Narrows source changes by imports while retaining workspace tests for runtime-read inputs.
 */
export async function selectRelatedCIScope(
	scope: CIScope,
	workspaces: readonly CIWorkspace[],
	changed: readonly string[],
	readFast: (changed: readonly string[]) => Promise<string[]>,
	readSlow: (changed: readonly string[]) => Promise<string[]>
): Promise<CIScope> {
	const modules = changed.filter(
		(file) => !file.endsWith(".md") && !file.startsWith(".agents/") && file !== "typos.toml"
	)

	if (scope.full || !modules.every((file) => /\.[cm]?[jt]sx?$/u.test(file)) || (!scope.fast && !scope.slow))
		return scope

	const [fast, slow] = await Promise.all([readFast(modules), readSlow(modules)])
	const runtimeTests = new Set(workspaces.flatMap((workspace) => workspace.runtimeInputs ?? []))
	const fastFiles = [...new Set([...fast, ...scope.fastFiles.filter((file) => runtimeTests.has(file))])].toSorted()
	const slowFiles = [...new Set([...slow, ...scope.slowFiles.filter((file) => runtimeTests.has(file))])].toSorted()

	return { ...scope, fastFiles, slowFiles, fast: fastFiles.length > 0, slow: slowFiles.length > 0 }
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
