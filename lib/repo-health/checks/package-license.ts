/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Refuse a workspace manifest whose `license` field is not the repository's expression in an admissible SPDX
 *   form.
 *
 *   The `license` field states the terms shipped in a release. Two failure classes reach consumers
 *   through this field without breaking a build. A deprecated identifier such as `AGPL-3.0` omits
 *   `-only` or `-or-later`. `summarizeLicense` reports it as `recognized: false` with an empty
 *   obligation list. A workspace that omits the commercial branch contradicts the public license page.
 *
 *   The root manifest provides the reference expression. The check validates its own field for
 *   admissibility before using it. A workspace that needs different terms raises a rights question.
 *   Record that decision in `docs/engineering/reference/artifact-rights-inventory.mdx` and the
 *   manifests it governs instead of adding an exception here.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { assertAdmissibleLicenseExpression } from "@mailwoman/core/license"
import { readWorkspaceDirectories } from "@mailwoman/core/workspaces"
import { resolvePath } from "path-ts"

import { type Diagnostic, DiagnosticSeverity, type RepoCheck } from "#repo-health/check"

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
 * The admissibility failure for one expression, or `undefined` when every identifier is
 * one the obligations table knows or a `LicenseRef-` this repository defines.
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
 * The `package-license` check: one error per workspace whose manifest declares no license, declares
 * an identifier the obligations table does not know, or declares an expression other than the root's.
 */
export const packageLicenseCheck: RepoCheck = {
	id: "package-license",
	description: "Every workspace manifest declares the root's license expression in an admissible SPDX form.",
	async run(context) {
		const diagnostics: Diagnostic[] = []
		const rootDeclared = await readDeclaredLicense(context.repoRoot, "package.json")

		if (typeof rootDeclared !== "string") {
			// Without the root's expression, the check has no basis for comparison.
			// One failure per workspace would bury the root error that must be fixed first.
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
