// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The `geocode` section of a `mailwoman.config.*` file: found, loaded through `c12` and validated.
 *
 *   The module imports `c12` only once a file is there to load, so a run with no config file never loads it.
 */

import { sortedGlob } from "@mailwoman/core/fs/readers"
import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { pick } from "@mailwoman/core/objects"
import { CommandError } from "@mailwoman/core/scripting/command"
import { type PathBuilderLike, resolvePath } from "path-ts"
import { z } from "zod"

import { GeocodeFileOptionsSchema } from "#geocode/options"

/**
 * The session options one config file states, with each unstated option absent.
 */
export type GeocodeFileOptions = Partial<z.output<typeof GeocodeFileOptionsSchema>>

/**
 * A config file that was read, and what its `geocode` key states.
 */
export interface GeocodeConfigFile {
	/**
	 * The absolute path of the file.
	 */
	path: string
	options: GeocodeFileOptions
}

/**
 * The whole file: session options under `geocode`, and no other key.
 */
const ConfigFileSchema = z.strictObject({ geocode: GeocodeFileOptionsSchema.optional() })

/**
 * One line per failing key, each opening with the key's dotted path in the file.
 */
function describeIssues(error: z.ZodError): string[] {
	return error.issues.flatMap((issue) => {
		if (issue.code === "unrecognized_keys") {
			return issue.keys.map((key) => `${[...issue.path, key].join(".")}: a config file can't set this key`)
		}

		return [`${issue.path.join(".") || "the file's top level"}: ${issue.message}`]
	})
}

/**
 * The config file to read: the one the caller gives, or the one `mailwoman.config.*` file in `directory`.
 *
 * @throws {CommandError} When `directory` holds more than one `mailwoman.config.*` file.
 */
async function findConfigFile(directory: PathBuilderLike, configFile: string | null): Promise<string | null> {
	if (configFile) return resolvePath(directory.toString(), configFile)

	const found = await sortedGlob(directory, "mailwoman.config.*")

	if (found.length > 1) {
		throw new CommandError(
			`${found.join(" and ")} are both config files. Keep one of them, or choose one with --config.`
		)
	}

	return found[0] ?? null
}

/**
 * Reads the session options a config file states under its `geocode` key.
 *
 * With `configFile`, it reads that path, relative to `directory`.
 * Without it, it reads the `mailwoman.config.*` file in `directory`, in any format `c12` loads:
 * JSON, YAML, TOML, or a JavaScript or TypeScript module with a default export.
 *
 * The answer holds only the keys the file states, so the caller's merge applies each default once.
 *
 * `c12`'s `extends` key, environment sections, `.mailwomanrc` files and `package.json`
 * section are all off: the one file is the whole configuration.
 *
 * @returns `null` when no `configFile` is given and `directory` holds no config file.
 * @throws {CommandError} When the file is absent, can't be loaded, or states a key
 * or value the schema refuses.
 * The message gives the file's path, and each failing key.
 */
export async function loadGeocodeConfigFile(
	directory: PathBuilderLike,
	configFile: string | null = null
): Promise<GeocodeConfigFile | null> {
	const path = await findConfigFile(directory, configFile)

	if (!path) return null

	if (!(await pathExists(path))) throw new CommandError(`The config file ${path} doesn't exist.`)

	const { loadConfig } = await import("c12")

	const loaded = await loadConfig({
		name: "mailwoman",
		cwd: directory.toString(),
		configFile: path,
		configFileRequired: true,
		rcFile: false,
		globalRc: false,
		packageJson: false,
		dotenv: false,
		envName: false,
		extend: false,
	}).catch((error: unknown) => {
		throw new CommandError(
			`The config file ${path} couldn't be loaded: ${error instanceof Error ? error.message : String(error)}`,
			{ cause: error }
		)
	})

	const parsed = ConfigFileSchema.safeParse(loaded.config)

	if (!parsed.success) {
		throw new CommandError(`The config file ${path} is refused:\n  ${describeIssues(parsed.error).join("\n  ")}`)
	}

	const validated = parsed.data.geocode ?? {}
	const stated = Object.keys(loaded.config.geocode ?? {}) as (keyof typeof validated)[]

	// Validation fills defaults, so the answer keeps only the keys the file itself states.
	return { path, options: pick(validated, stated) }
}
