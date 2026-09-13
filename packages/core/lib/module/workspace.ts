/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Workspace names paired with their declared repo-relative directories. The root manifest is authoritative: package
 *   names are not paths (`@mailwoman/core` lives at `packages/core`), and deriving one from the other recreates the
 *   exact class of clean-command bug this registry exists to prevent.
 */

import { PathBuilder, resolvePath, type PathBuilderLike } from "path-ts"
import type { Tagged } from "type-fest"

import { readPackageJSON } from "#module/resolve-from"
import { OutDirectoryName } from "#paths"
import { readWorkspaceDirectories } from "#workspaces"

/**
 * A package name proven to occur in the root manifest's expanded workspace set.
 */
export type WorkspacePackage = Tagged<string, "WorkspacePackage">

export class WorkspacePackages extends Map<WorkspacePackage, string> {
	public readonly repoRoot: string

	private constructor(repoRoot: PathBuilderLike, entries: Iterable<readonly [WorkspacePackage, string]>) {
		super(entries)
		this.repoRoot = resolvePath(repoRoot)
	}

	/**
	 * Read the root workspace field and pair every package name with its repo-relative directory.
	 */
	public static async read(repoRoot: PathBuilderLike): Promise<WorkspacePackages> {
		const directories = await readWorkspaceDirectories(repoRoot)

		const entries = await Promise.all(
			directories.map(async (directory): Promise<readonly [WorkspacePackage, string]> => {
				const manifest = await readPackageJSON(resolvePath(repoRoot, directory, "package.json"))

				if (!manifest.name) {
					throw new Error(`Workspace ${directory} has no package name`)
				}

				return [manifest.name as WorkspacePackage, directory]
			})
		)

		const packages = new WorkspacePackages(repoRoot, entries)

		if (packages.size !== entries.length) {
			throw new Error("Workspace package names must be unique")
		}

		return packages
	}

	public validate(value: unknown): value is WorkspacePackage {
		return typeof value === "string" && this.has(value as WorkspacePackage)
	}

	/**
	 * Absolute path builder for a package's declared workspace directory.
	 */
	public packagePathBuilder(packageName: WorkspacePackage, ...pathSegments: string[]): PathBuilder {
		const directory = this.get(packageName)

		if (!directory) {
			throw new Error(`Unknown workspace package: ${packageName}`)
		}

		return PathBuilder.from(this.repoRoot, directory, ...pathSegments)
	}

	/**
	 * Absolute path builder for a package's TypeScript output directory.
	 */
	public tsOutPathBuilder(packageName: WorkspacePackage, ...pathSegments: string[]): PathBuilder {
		return this.packagePathBuilder(packageName, OutDirectoryName, ...pathSegments)
	}

	/**
	 * Absolute path builder for a package's distribution directory.
	 */
	public distPathBuilder(packageName: WorkspacePackage, ...pathSegments: string[]): PathBuilder {
		return this.packagePathBuilder(packageName, "dist", ...pathSegments)
	}

	public get packageNames(): readonly WorkspacePackage[] {
		return Array.from(this.keys())
	}

	public get packageCount(): number {
		return this.size
	}

	/**
	 * Every directory cleanup is permitted to mutate for this workspace set.
	 */
	public get generatedDirectoryRoots(): readonly PathBuilder[] {
		return this.packageNames.flatMap((packageName) => [
			this.tsOutPathBuilder(packageName),
			this.distPathBuilder(packageName),
		])
	}
}
