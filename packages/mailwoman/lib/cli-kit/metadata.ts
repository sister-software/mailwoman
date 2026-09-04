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
/**
 * The fields of mailwoman's own `package.json` that the CLI reports about itself: the version (`--version`), the Node
 * engines floor (the doctor), and the license expression (the doctor's posture line).
 */
export interface MailwomanManifest {
	version: string
	engines?: { node?: string }
	license?: string
}

/**
 * Read mailwoman's own manifest by package self-reference, so the same file answers from the source tree, `out/`, and a
 * published tarball. The one place this read happens; the doctor and the license command both call it.
 */
export async function readMailwomanManifest(): Promise<MailwomanManifest> {
	const { resolvePackagePath } = await import("@mailwoman/core/module/resolvers")
	const { readLocalJSONFile } = await import("@mailwoman/core/fs/readers")

	const manifestPath = resolvePackagePath("mailwoman", "package.json")

	const manifest = await readLocalJSONFile<{ version?: unknown; engines?: { node?: string }; license?: string }>(
		manifestPath
	)

	if (typeof manifest.version !== "string") {
		throw new TypeError(`Missing string version in ${manifestPath}`)
	}

	return {
		version: manifest.version,
		...(manifest.engines ? { engines: manifest.engines } : {}),
		...(manifest.license ? { license: manifest.license } : {}),
	}
}

export async function readMailwomanVersion(): Promise<string> {
	return (await readMailwomanManifest()).version
}
