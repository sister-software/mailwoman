import { parseEnv } from "@mailwoman/platform/util"
import type { PathBuilderLike } from "path-ts"

import { pathExistsSync, readLocalTextFileSync } from "#fs/readers-sync"

/**
 * Parse a `.env` file into a record. Returns `{}` when the file is absent (a `.env` is optional — the real environment
 * is the source of truth; see {@link file://./index.ts}). Values are strings, as written.
 */
export function loadEnvFile<T extends object = object>(envFilePath: PathBuilderLike | URL): T {
	if (!pathExistsSync(envFilePath)) return {} as T

	const envFileContent = readLocalTextFileSync(envFilePath)

	return parseEnv(envFileContent) as T
}
