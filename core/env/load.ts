import { existsSync, type PathLike, readFileSync } from "node:fs"
import { parseEnv } from "node:util"

/**
 * Parse a `.env` file into a record. Returns `{}` when the file is absent (a `.env` is optional — the real environment
 * is the source of truth; see {@link file://./index.ts}). Values are strings, as written.
 */
export function loadEnvFile<T extends object = object>(envFilePath: PathLike): T {
	if (!existsSync(envFilePath)) return {} as T

	const envFileContent = readFileSync(envFilePath, "utf-8")

	return parseEnv(envFileContent) as T
}
