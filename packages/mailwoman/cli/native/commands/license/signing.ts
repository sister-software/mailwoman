// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The issuer's signing keys under `$MAILWOMAN_CONFIG_ROOT/license`: their file names,
 *   and the read of a private key whose public half the shipped trust register lists.
 */

import { configRootPath } from "@mailwoman/core/data-root"
import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { resolvePath } from "path-ts"

import { CLIError, type ParsedCommand, stringValue } from "#cli/native/spec"

/**
 * The file `keygen` writes the license signing key to: it signs platform keys and training grants.
 */
export const SIGNING_KEY_FILE = "signing-key.pem"

/**
 * The file `keygen` writes the license signing key's public half to.
 */
export const PUBLIC_KEY_FILE = "signing-key.pub.pem"

/**
 * The file `keygen --use provenance` writes the provenance signing key to:
 * it signs model provenance manifests.
 */
export const PROVENANCE_KEY_FILE = "provenance-key.pem"

/**
 * The file `keygen --use provenance` writes the provenance signing key's public half to.
 */
export const PROVENANCE_PUBLIC_KEY_FILE = "provenance-key.pub.pem"

/**
 * The directory the issuer's keys are written to and read from.
 */
export const licenseConfigPath = configRootPath("license")

/**
 * The issuer's private key and the key id the shipped register lists for its public half.
 *
 * `--signing-key` overrides the default file.
 *
 * @throws When the key is missing, or its public half isn't in `keys`,
 * since what it signs would verify nowhere.
 */
export async function registeredSigningKey(
	parsed: ParsedCommand,
	defaultFile: string,
	publicFile: string,
	keys: Readonly<Record<string, string>>
): Promise<{ kid: string; privateKeyPEM: string }> {
	const signingKeyPath = stringValue(parsed.values, "signing-key") ?? licenseConfigPath(defaultFile)

	if (!(await pathExists(signingKeyPath))) {
		throw new CLIError(
			`No signing key at ${signingKeyPath}. Run \`mailwoman license keygen\` first, or pass --signing-key.`
		)
	}

	const privateKeyPEM = await readLocalTextFile(signingKeyPath)
	const publicKeyPath = resolvePath(signingKeyPath.replace(/\.pem$/u, ""), "..", publicFile)
	const publicKeyPEM = (await pathExists(publicKeyPath)) ? await readLocalTextFile(publicKeyPath) : null
	const trusted = publicKeyPEM ? Object.entries(keys).find(([, pem]) => pem.trim() === publicKeyPEM.trim()) : null

	if (!trusted) {
		throw new CLIError(
			`The public half of ${signingKeyPath} is not in this build's register (packages/license/lib/product/trust-register.json), so what it signs would verify nowhere. Add it and rebuild first.`
		)
	}

	return { kid: trusted[0], privateKeyPEM }
}
