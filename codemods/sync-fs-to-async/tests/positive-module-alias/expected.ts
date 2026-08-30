import { pathExists, readLocalTextFile } from "@mailwoman/core/fs/readers"

import * as fs from "node:fs"

export async function present(p: string): Promise<boolean> {
	return await pathExists(p)
}

/**
 * A Node-only module reached through a PARALLEL dynamic import, so the binding is one element of an array pattern
 * destructured from `Promise.all` and its POSITION is what ties the name to the module.
 */
export async function load(a: string, b: string): Promise<string> {
	const [{ resolveWeights }, node] = await Promise.all([
		import("./weights.ts"),
		import("@mailwoman/platform/fs"),
	])

	void resolveWeights

	return await readLocalTextFile(a) + await readLocalTextFile(b)
}
