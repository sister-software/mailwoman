import { stringifyJSON } from "@mailwoman/core/json"

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
 * The encoded description remains readable by the transitional schema adapter;
 * native commands express positionals directly in `CommandSpec` and do not need this helper.
 */
export function argument(config: CommandArgumentMetadata): string {
	return `__mailwoman_argument_config__${stringifyJSON(config)}`
}

/**
 * The fields of mailwoman's own `package.json` that the CLI reports about itself:
 * the version (`--version`), the Node engines floor (the doctor), and the license
 * expression (the doctor's posture line).
 */
export interface MailwomanManifest {
	version: string
	engines?: { node?: string }
	license: string
	bin?: Record<string, string>
}

/**
 * The manifest's own `bin.mailwoman` is what `npm` installs against, so the entry point
 * is read from it rather than assembled from a path no sweep or check covers.
 */
export async function mailwomanCLIPath(): Promise<string> {
	const { resolvePackagePath } = await import("@mailwoman/core/module/resolvers")
	const { bin } = await readMailwomanManifest()
	const entry = bin?.mailwoman

	if (!entry) throw new TypeError("mailwoman's manifest declares no `bin.mailwoman`.")

	return resolvePackagePath("mailwoman", entry)
}

let manifest: Promise<MailwomanManifest> | undefined

/**
 * Read by package self-reference so the same file answers from the source tree, `out/`,
 * and a published tarball; the one place this read happens, memoized for the process.
 *
 * @throws {TypeError} When the manifest carries no string `version` or `license` —
 * a broken install rather than a choice.
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
