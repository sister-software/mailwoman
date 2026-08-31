import { existsSync, readFileSync } from "node:fs"

// A sync function: converting it changes its signature, and every caller's.
export function readConfig(path: string): string | null {
	return existsSync(path) ? readFileSync(path, "utf8") : null
}

// Top level: an `await` here would move the read to import time.
export const banner = readFileSync("banner.txt", "utf8")

export async function listPresent(paths: string[]): Promise<string[]> {
	// A non-async callback. Its own signature is free to change, but that is a decision, not a rename.
	return paths.filter((path) => existsSync(path))
}
