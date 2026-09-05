/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Refuse a tree whose committed well-known key file differs from the typed register it derives from. The doctor and
 *   `license verify --online` read the committed file from mailwoman.ai; the shipped trust map reads the typed register;
 *   a difference between them is a key that one side trusts and the other does not. Parsed JSON is compared, not text,
 *   so the repository formatter may lay the file out as it likes.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { publishedLicenseKeys } from "@mailwoman/core/license"
import { resolvePath } from "path-ts"

import { type Diagnostic, DiagnosticSeverity, type RepoCheck } from "#check"

const WELL_KNOWN_FILE = "docs/static/.well-known/mailwoman/license-keys.json"

/**
 * The `license-register` check: one error when the committed well-known file and the register's derivation differ.
 */
export const licenseRegisterCheck: RepoCheck = {
	id: "license-register",
	description: "The committed well-known license-key file equals the typed register's derivation.",
	async run(context) {
		const committed = await readLocalJSONFile<unknown>(resolvePath(context.repoRoot, WELL_KNOWN_FILE))
		const derived = publishedLicenseKeys()
		const diagnostics: Diagnostic[] = []

		if (JSON.stringify(committed) !== JSON.stringify(derived)) {
			diagnostics.push({
				severity: DiagnosticSeverity.Error,
				message: `${WELL_KNOWN_FILE} differs from packages/core/lib/license/register.ts — run \`mailwoman license register --write\``,
				file: WELL_KNOWN_FILE,
			})
		}

		return diagnostics
	},
}
