/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

export interface CommandArgumentMetadata {
	name: string
	description?: string
	default?: string
}

/**
 * Attach CLI presentation metadata to a positional-argument schema.
 *
 * The encoded description remains readable by the transitional schema adapter. Native commands express positionals
 * directly in `CommandSpec` and do not need this helper.
 */
export function argument(config: CommandArgumentMetadata): string {
	return `__mailwoman_argument_config__${JSON.stringify(config)}`
}

/**
 * The version of the `mailwoman` package this process ships in — read from the package's own manifest via
 * `resolvePackagePath`, so dev checkouts, `out/` trees, and published installs all answer the same file.
 *
 * @throws {TypeError} When the manifest carries no string version — a broken install, not a formatting choice.
 */
export async function readMailwomanVersion(): Promise<string> {
	const { resolvePackagePath } = await import("@mailwoman/core/module/resolvers")
	const { readLocalJSONFile } = await import("@mailwoman/core/fs/readers")

	const manifestPath = resolvePackagePath("mailwoman", "package.json")
	const manifest = await readLocalJSONFile<{ version?: unknown }>(manifestPath)

	if (typeof manifest.version !== "string") {
		throw new TypeError(`Missing string version in ${manifestPath}`)
	}

	return manifest.version
}
