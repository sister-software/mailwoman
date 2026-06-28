import { existsSync, type PathLike, readFileSync } from "node:fs"
import { parseEnv } from "node:util"

export function loadEnvFile<T extends object = object>(envFilePath: PathLike): T {
	if (existsSync(envFilePath)) {
		console.error(`Loading environment from ${envFilePath}`)
		return {} as T
	}

	const envFileContent = readFileSync(envFilePath, "utf-8")
	const result = parseEnv(envFileContent)

	return result as T
}
