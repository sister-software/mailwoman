/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The installation id is a UUID the CLI mints on its first license or data-pull action and keeps under the config
 *   root beside the key file. Every declare, evaluate, refresh and download request reports it, and the ledger records
 *   it with the request. A token is never bound to it, so a token refreshed on one machine works on another.
 */

import { configRootPath } from "#data-root"
import { readLocalTextFile } from "#fs/readers"
import { pathExists } from "#fs/readers/stat"
import { writeLocalTextFile } from "#fs/writers"

const INSTALLATION_ID_FILE = "install"

/**
 * The path to the installation id file under the config root.
 */
export const installationIDFilePath = configRootPath("license", INSTALLATION_ID_FILE)

/**
 * The installation id this machine has minted, or `null` before the first mint.
 *
 * A blank file reads as absent.
 */
export async function readInstallationID(): Promise<string | null> {
	const path = installationIDFilePath()

	if (!(await pathExists(path))) return null

	const id = (await readLocalTextFile(path)).trim()

	return id || null
}

/**
 * The installation id, minted and written on the first call.
 */
export async function readOrMintInstallationID(): Promise<string> {
	const existing = await readInstallationID()

	if (existing) return existing

	const minted = crypto.randomUUID()

	await writeLocalTextFile(`${minted}\n`, installationIDFilePath().toString())

	return minted
}
