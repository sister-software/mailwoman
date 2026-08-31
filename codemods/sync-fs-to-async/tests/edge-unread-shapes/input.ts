import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"

export async function edges(path: string): Promise<string> {
	// The created path is read, and the two directory helpers do not answer it the same way.
	const created = mkdirSync(path, { recursive: true })

	// An encoding the table does not read.
	const latin = readFileSync(path, "latin1")

	// A stat with options.
	const stats = statSync(path, { bigint: true })

	// A removal whose options are neither shape the helpers cover.
	rmSync(path, { maxRetries: 3 })

	writeFileSync(path, latin, "latin1")

	return `${created}${stats.size}`
}
