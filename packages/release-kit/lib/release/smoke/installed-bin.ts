/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Locates the `mailwoman` executable inside a clean-install probe project.
 */

import { readPackageJSON } from "@mailwoman/core/module/resolve-from"
import type { PathBuilder } from "path-ts"

/**
 * Returns the path of the `mailwoman` bin entry from the manifest of the
 * package installed under `projectDir`.
 *
 * The smokes read the bin entry from the installed manifest because the published
 * package may move the compiled file.
 *
 * @throws When the installed manifest declares no `mailwoman` bin.
 */
export async function installedMailwomanBin(projectDir: PathBuilder): Promise<PathBuilder> {
	const installedRoot = projectDir("node_modules", "mailwoman")
	const { bin } = await readPackageJSON<{ bin?: string | Record<string, string> }>(installedRoot("package.json"))
	const binEntry = typeof bin === "string" ? bin : bin?.mailwoman

	if (!binEntry) throw new Error("[smoke] the installed mailwoman manifest declares no `mailwoman` bin")

	return installedRoot(binEntry)
}
