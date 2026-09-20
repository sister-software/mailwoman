/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Every document that grants first-party rights names the same party as granting them.
 *
 *   A licensee tracing who they contracted with reads five documents written at different times: the open-source
 *   license, the commercial reference template, the versioned checkout agreement, the contributor grant, and the public
 *   license page. A party named in four of them and absent from the fifth is the shape a rights chain breaks in, and
 *   nothing compared them.
 *
 *   The check is presence rather than prose. It does not read what each document grants, which differs by document and
 *   is the point of having five. It refuses a rights document that never names the licensor, since a grant with no
 *   named grantor is one a licensee cannot trace.
 *
 *   The services operator is deliberately not checked here. `Nirrus LLC` appears in the website Terms and Privacy
 *   Policy and in no rights document, which is correct: operating the services does not make it the copyright holder,
 *   and requiring it here would assert the opposite.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { resolvePath } from "path-ts"

import { type Diagnostic, DiagnosticSeverity, type RepoCheck } from "#check"

/**
 * The party every first-party grant flows from, as the rights documents spell it.
 */
const LICENSOR = "Sister Software"

/**
 * The documents that grant, receive or describe first-party rights, each with what it is for.
 *
 * A generated per-package `LICENSE.md` is checked by `weights-rights` against its generator instead, so it is absent
 * here — one document, one owning check.
 */
const RIGHTS_DOCUMENTS: ReadonlyArray<readonly [path: string, role: string]> = [
	["LICENSE.md", "the open-source grant"],
	["COMMERCIAL-LICENSE.md", "the commercial reference template"],
	["CONTRIBUTING.md", "the contributor grant this repository relies on to sublicense a contribution"],
	["docs/src/pages/license.mdx", "the public license page"],
	["docs/src/pages/license/terms/commercial-2026-10.mdx", "the versioned checkout agreement"],
]

/**
 * The `rights-chain` check: one error per rights document that does not name the licensor.
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
