/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The `mailwoman` executable inside a clean-install probe project.
 */

import { readPackageJSON } from "@mailwoman/core/module/resolve-from"
import type { PathBuilder } from "path-ts"

/**
 * The `mailwoman` bin entry of the package installed under `projectDir`, read from the installed manifest.
 *
 * The smokes read the entry rather than spell the compiled path.
 * The published package may move its entry, and a spelled path then names a file that no
 * longer ships, so the probe reports a missing module instead of exercising the CLI.
 *
 * The installed manifest is the interface a consumer reaches, which is what a clean-install probe tests.
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
