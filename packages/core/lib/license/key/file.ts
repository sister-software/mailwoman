/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The two files under `$MAILWOMAN_CONFIG_ROOT/license/` a self-service license leaves on a machine: the key, which
 *   `verifyConfiguredLicenseKey` reads after `MAILWOMAN_LICENSE_KEY`, so a refreshed token applies without an
 *   environment change; and the refresh credentials, the lid and per-license secret `mailwoman license refresh`
 *   presents, created 0600 because the secret is what fetches renewals. The key is a signed assertion, not a secret,
 *   and is written with the ordinary writer.
 */

import { configRootPath } from "#data-root"
import { $public } from "#env"
import { pathExists, readLocalJSONFile, readLocalTextFile } from "#fs/readers"
import { writeLocalTextFile, writePrivateTextFile } from "#fs/writers"

const LICENSE_KEY_FILE = "key"
const LICENSE_REFRESH_FILE = "refresh.json"

export function licenseKeyFilePath(): string {
	return String(configRootPath("license", LICENSE_KEY_FILE))
}

export function licenseRefreshFilePath(): string {
	return String(configRootPath("license", LICENSE_REFRESH_FILE))
}

export interface ConfiguredLicenseToken {
	token: string
	source: "environment" | "file"
}

/**
 * The token this installation has configured: the environment variable first, the key file second. `undefined` when
 * neither is set; a blank file reads as absent.
 */
export async function readConfiguredLicenseToken(): Promise<ConfiguredLicenseToken | undefined> {
	const fromEnvironment = $public.MAILWOMAN_LICENSE_KEY

	if (fromEnvironment) return { token: fromEnvironment, source: "environment" }

	const path = licenseKeyFilePath()

	if (!(await pathExists(path))) return undefined

	const token = (await readLocalTextFile(path)).trim()

	return token ? { token, source: "file" } : undefined
}

/**
 * Write the key file; answers its path.
 */
export async function writeLicenseKeyFile(token: string): Promise<string> {
	const path = licenseKeyFilePath()

	await writeLocalTextFile(`${token.trim()}\n`, path)

	return path
}

export interface RefreshCredentials {
	lid: string
	secret: string
}

export async function readRefreshCredentials(): Promise<RefreshCredentials | undefined> {
	const path = licenseRefreshFilePath()

	if (!(await pathExists(path))) return undefined

	const parsed = await readLocalJSONFile<Partial<RefreshCredentials>>(path)

	if (typeof parsed.lid !== "string" || typeof parsed.secret !== "string") {
		throw new TypeError(`${path} does not carry a lid and a secret; run \`mailwoman license adopt\` again`)
	}

	return { lid: parsed.lid, secret: parsed.secret }
}

/**
 * Write the refresh credentials, created 0600; answers the path.
 */
export async function writeRefreshCredentials(credentials: RefreshCredentials): Promise<string> {
	const path = licenseRefreshFilePath()

	await writePrivateTextFile(`${JSON.stringify(credentials, null, "\t")}\n`, path)

	return path
}
