/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   A self-service license leaves two files under `$MAILWOMAN_CONFIG_ROOT/license/`.
 *   `verifyConfiguredLicenseKey` reads the key after `MAILWOMAN_LICENSE_KEY`, so a refreshed token applies without an
 *   environment change. The other file stores the refresh credentials: the license ID and per-license secret that
 *   `mailwoman license refresh` presents. It is created with mode 0600 because the secret fetches renewals.
 *   The key is a signed assertion. The ordinary writer stores it.
 */

import { configRootPath } from "#data-root"
import { $public } from "#env"
import { pathExists, readLocalJSONFile, readLocalTextFile } from "#fs/readers"
import { writeLocalTextFile, writePrivateTextFile } from "#fs/writers"
import { prettyJSON } from "#json"

const LICENSE_KEY_FILE = "key"
const LICENSE_REFRESH_FILE = "refresh.json"

/**
 * The path to the license key file under the config root.
 */
export const licenseKeyFilePath = configRootPath("license", LICENSE_KEY_FILE)

/**
 * The path to the refresh credentials file under the config root.
 */
export const licenseRefreshFilePath = configRootPath("license", LICENSE_REFRESH_FILE)

export interface ConfiguredLicenseToken {
	token: string
	source: "environment" | "file"
}

/**
 * The token this installation has configured: the environment variable first, the key file second.
 *
 * `null` when neither is set.
 * A blank file reads as absent.
 */
export async function readConfiguredLicenseToken(): Promise<ConfiguredLicenseToken | null> {
	const fromEnvironment = $public.MAILWOMAN_LICENSE_KEY

	if (fromEnvironment) return { token: fromEnvironment, source: "environment" }

	const path = licenseKeyFilePath()

	if (!(await pathExists(path))) return null

	const token = (await readLocalTextFile(path)).trim()

	return token ? { token, source: "file" } : null
}

/**
 * Write the key file.
 * Answers its path.
 */
export async function writeLicenseKeyFile(token: string, destination = licenseKeyFilePath()): Promise<string> {
	const path = destination.toString()

	await writeLocalTextFile(`${token.trim()}\n`, path)

	return path
}

export interface RefreshCredentials {
	lid: string
	secret: string
}

/**
 * Read the refresh credentials, created 0600.
 *
 * @returns The credentials, or `null` when the file is absent.
 * @throws when the file is present but does not carry a lid and a secret.
 */
export async function readRefreshCredentials(): Promise<RefreshCredentials | null> {
	const path = licenseRefreshFilePath()

	if (!(await pathExists(path))) return null

	const parsed = await readLocalJSONFile<Partial<RefreshCredentials>>(path)

	if (typeof parsed.lid !== "string" || typeof parsed.secret !== "string") {
		throw new TypeError(`${path} does not carry a lid and a secret; run \`mailwoman license adopt\` again`)
	}

	return { lid: parsed.lid, secret: parsed.secret }
}

/**
 * Write the refresh credentials, mode 0600.
 *
 * @returns The path to the file.
 */
export async function writeRefreshCredentials(credentials: RefreshCredentials): Promise<string> {
	const path = licenseRefreshFilePath().toString()

	await writePrivateTextFile(prettyJSON(credentials), path)

	return path
}
