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
	bin?: Record<string, string>
}

/**
 * The compiled CLI's entry point, taken from the manifest's own `bin` rather than assembled from segments.
 *
 * Nineteen call sites spelled `workspacePath("mailwoman", "out", "cli.js")`, and every one of them named a file that
 * had moved — a path built from pieces matches no sweep and is checked by nothing until the process fails to start. The
 * manifest already states where the binary is, and that statement is what `npm` installs against.
 */
export async function mailwomanCLIPath(): Promise<string> {
	const { resolvePackagePath } = await import("@mailwoman/core/module/resolvers")
	const { bin } = await readMailwomanManifest()
	const entry = bin?.mailwoman

	if (!entry) throw new TypeError("mailwoman's manifest declares no `bin.mailwoman`.")

	return String(resolvePackagePath("mailwoman", entry))
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

	const raw = await readLocalJSONFile<{
		version?: unknown
		engines?: { node?: string }
		license?: unknown
		bin?: Record<string, string>
	}>(manifestPath)

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
		...(raw.bin ? { bin: raw.bin } : {}),
	}
}

export async function readMailwomanVersion(): Promise<string> {
	return (await readMailwomanManifest()).version
}
