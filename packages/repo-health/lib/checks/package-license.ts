/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Refuse a workspace manifest whose `license` field is not the repository's expression in an admissible SPDX form.
 *
 *   The `license` field is what npm shows on a package page and what a consumer's own audit reads, so it is the
 *   published statement of the terms a release ships under. Two failure classes reach consumers through it and neither
 *   one breaks a build.
 *
 *   A deprecated identifier states less than it appears to. `AGPL-3.0` names neither the `-only` nor the `-or-later`
 *   variant, and `summarizeLicense` in `@mailwoman/core/license` reports it `recognized: false` with an empty
 *   obligation list. A reader who checks the obligations without checking the flag sees a package that requires
 *   nothing.
 *
 *   A workspace omitting the commercial branch contradicts the public license page, which states that every release
 *   ships under both.
 *
 *   The root manifest is the reference rather than a constant here, for the same reason `version-sync` reads it: one
 *   place states the expression, and the root's own field is checked for admissibility before it is used as the
 *   reference. A workspace that needs different terms is a rights question rather than a formatting one, so it belongs
 *   in `docs/engineering/reference/artifact-rights-inventory.mdx` and in the manifests it governs, never in an
 *   exception list here.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { assertAdmissibleLicenseExpression } from "@mailwoman/core/license"
import { readWorkspaceDirectories } from "@mailwoman/core/workspaces"
import { resolvePath } from "path-ts"

import { type Diagnostic, DiagnosticSeverity, type RepoCheck } from "#check"

/**
 * The declared expression, or the reason the manifest states none.
 */
async function readDeclaredLicense(repoRoot: string, file: string): Promise<string | Diagnostic> {
	const manifest = await readLocalJSONFile<{ license?: unknown }>(resolvePath(repoRoot, file))

	if (typeof manifest.license !== "string" || !manifest.license.length) {
		return {
			severity: DiagnosticSeverity.Error,
			message: `${file} declares no "license" string, so the workspace's source states no terms and a published one reaches npm that way`,
			file,
		}
	}

	return manifest.license
}

/**
 * The admissibility failure for one expression, or `undefined` when every identifier is one the obligations table knows
 * or a `LicenseRef-` this repository defines.
 */
function admissibilityDiagnostic(expression: string, file: string): Diagnostic | undefined {
	try {
		assertAdmissibleLicenseExpression(expression, file)

		return undefined
	} catch (error) {
		return {
			severity: DiagnosticSeverity.Error,
			message: error instanceof Error ? error.message : String(error),
			file,
		}
	}
}

/**
 * The `package-license` check: one error per workspace whose manifest declares no license, declares an identifier the
 * obligations table does not know, or declares an expression other than the root's.
 */
export const packageLicenseCheck: RepoCheck = {
	id: "package-license",
	description: "Every workspace manifest declares the root's license expression in an admissible SPDX form.",
	async run(context) {
		const diagnostics: Diagnostic[] = []
		const rootDeclared = await readDeclaredLicense(context.repoRoot, "package.json")

		if (typeof rootDeclared !== "string") {
			// Without the root's expression there is nothing to compare the workspaces against, and reporting 75 identical
			// failures would bury the one that has to be fixed first.
			return [rootDeclared]
		}

		const rootAdmissibility = admissibilityDiagnostic(rootDeclared, "package.json")

		if (rootAdmissibility) return [rootAdmissibility]

		for (const workspace of await readWorkspaceDirectories(context.repoRoot)) {
			const file = `${workspace}/package.json`
			const declared = await readDeclaredLicense(context.repoRoot, file)

			if (typeof declared !== "string") {
				diagnostics.push(declared)

				continue
			}

			const admissibility = admissibilityDiagnostic(declared, file)

			if (admissibility) {
				diagnostics.push(admissibility)

				continue
			}

			if (declared !== rootDeclared) {
				diagnostics.push({
					severity: DiagnosticSeverity.Error,
					message: `${workspace} declares "${declared}" where the root declares "${rootDeclared}" — npm shows the workspace's field, so a consumer reads the narrower terms`,
					file,
				})
			}
		}

		return diagnostics
	},
}
