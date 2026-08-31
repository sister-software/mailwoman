import { parseEnv } from "node:util"

import type { PathBuilderLike } from "path-ts"

import { pathExists, readLocalTextFile } from "#fs/readers"

/**
 * Parse a `.env` file into a record. Returns `{}` when the file is absent (a `.env` is optional — the real environment
 * is the source of truth; see {@link file://./index.ts}). Values are strings, as written.
 */
export async function loadEnvFile<T extends object = object>(envFilePath: PathBuilderLike | URL): Promise<T> {
	if (!(await pathExists(envFilePath))) return {} as T

	const envFileContent = await readLocalTextFile(envFilePath)

	return parseEnv(envFileContent) as T
}
