/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Checks that every document granting first-party rights mentions the licensor.
 *
 *   The check tests only that the licensor's name appears in each document. It does not compare what each document
 *   grants. The services operator, `Nirrus LLC`, is not the copyright holder and is intentionally left out.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { resolvePath } from "path-ts"

import { type Diagnostic, DiagnosticSeverity, type RepoCheck } from "#check"

/**
 * The licensor's name as the rights documents spell it.
 */
const LICENSOR = "Sister Software"

/**
 * The documents that grant, receive or describe first-party rights, each with its role.
 *
 * The `weights-rights` check covers the generated per-package `LICENSE.md` files.
 */
const RIGHTS_DOCUMENTS: ReadonlyArray<readonly [path: string, role: string]> = [
	["LICENSE.md", "the open-source grant"],
	["COMMERCIAL-LICENSE.md", "the commercial reference template"],
	["CONTRIBUTING.md", "the contributor grant this repository relies on to sublicense a contribution"],
	["docs/src/pages/license.mdx", "the public license page"],
	["docs/src/pages/license/terms/commercial-2026-10.mdx", "the versioned checkout agreement"],
]

/**
 * The `rights-chain` check.
 *
 * It reports one error for each rights document that is unreadable or lacks the licensor's name.
 */
export const rightsChainCheck: RepoCheck = {
	id: "rights-chain",
	description: "Every document granting first-party rights names the licensor.",
	async run(context) {
		const diagnostics: Diagnostic[] = []

		for (const [path, role] of RIGHTS_DOCUMENTS) {
			let text: string

			try {
				text = await readLocalTextFile(resolvePath(context.repoRoot, path))
			} catch {
				diagnostics.push({
					severity: DiagnosticSeverity.Error,
					message: `${path} is ${role} and could not be read, so the rights chain cannot be traced through it`,
					file: path,
				})

				continue
			}

			if (text.includes(LICENSOR)) continue

			diagnostics.push({
				severity: DiagnosticSeverity.Error,
				message: `${path} is ${role} and never names ${LICENSOR} — a licensee reading it alone cannot tell who grants the rights`,
				file: path,
			})
		}

		return diagnostics
	},
}
