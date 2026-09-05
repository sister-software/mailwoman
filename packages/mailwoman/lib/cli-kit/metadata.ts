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
	license: string
}

let manifest: Promise<MailwomanManifest> | undefined

/**
 * Read mailwoman's own manifest by package self-reference, so the same file answers from the source tree, `out/`, and a
 * published tarball. The one place this read happens, and it happens once per process: the version line, the license
 * notice, the doctor and the license command all read the same file.
 *
 * @throws {TypeError} When the manifest carries no string `version` or `license` — a broken install, not a choice.
 */
export function readMailwomanManifest(): Promise<MailwomanManifest> {
	manifest ??= readManifestFile()

	return manifest
}

async function readManifestFile(): Promise<MailwomanManifest> {
	const { resolvePackagePath } = await import("@mailwoman/core/module/resolvers")
	const { readLocalJSONFile } = await import("@mailwoman/core/fs/readers")

	const manifestPath = resolvePackagePath("mailwoman", "package.json")

	const raw = await readLocalJSONFile<{ version?: unknown; engines?: { node?: string }; license?: unknown }>(
		manifestPath
	)

	if (typeof raw.version !== "string") {
		throw new TypeError(`Missing string version in ${manifestPath}`)
	}

	if (typeof raw.license !== "string") {
		throw new TypeError(`Missing string license in ${manifestPath}`)
	}

	return {
		version: raw.version,
		license: raw.license,
		...(raw.engines ? { engines: raw.engines } : {}),
	}
}

export async function readMailwomanVersion(): Promise<string> {
	return (await readMailwomanManifest()).version
}
