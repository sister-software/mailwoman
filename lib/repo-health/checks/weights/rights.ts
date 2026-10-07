/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Every published weights package ships its generated `LICENSE.md` and `PROVENANCE.json`, and both hold what the
 *   package's manifest and model card currently say.
 *
 * Both files are derived, so this check holds the committed bytes equal to `mwops release write-rights-files`'s output
 * so a model card edit regenerates them or fails here.
 *
 * A generated file the manifest's `files` array does not declare never reaches the tarball, so that array is checked
 * alongside.
 */

import { readLocalJSONFile, readLocalTextFile } from "@mailwoman/core/fs/readers"
import { readPackageJSON } from "@mailwoman/core/module/resolve-from"
import { resolvePath } from "path-ts"

import { LICENSE_FILE, PROVENANCE_FILE, provenanceMatches, renderLicenseFile } from "#release-kit/weights/rights/files"
import { weightsRightsRecords } from "#release-kit/weights/rights/write"
import { type Diagnostic, DiagnosticSeverity, type RepoCheck } from "#repo-health/check"

const REGENERATE = "run `yarn mwops release write-rights-files`"

/**
 * The `weights-rights` check: one error per published weights package whose generated
 * rights files are missing, stale, or undeclared in the manifest's `files` array.
 */
export const weightsRightsCheck: RepoCheck = {
	id: "weights-rights",
	description: "Every published weights package ships current generated LICENSE.md and PROVENANCE.json files.",
	async run(context) {
		const diagnostics: Diagnostic[] = []

		for (const record of await weightsRightsRecords(context.repoRoot)) {
			const licenseFile = `${record.workspace}/${LICENSE_FILE}`
			const provenanceFile = `${record.workspace}/${PROVENANCE_FILE}`

			try {
				const committed = await readLocalTextFile(resolvePath(context.repoRoot, licenseFile))

				if (committed !== renderLicenseFile(record)) {
					diagnostics.push({
						severity: DiagnosticSeverity.Error,
						message: `${licenseFile} differs from what the manifest states — ${REGENERATE}`,
						file: licenseFile,
						line: null,
						details: null,
					})
				}
			} catch {
				diagnostics.push({
					severity: DiagnosticSeverity.Error,
					message: `${licenseFile} is missing, so the tarball states its terms nowhere — ${REGENERATE}`,
					file: licenseFile,
					line: null,
					details: null,
				})
			}

			try {
				const committed = await readLocalJSONFile<unknown>(resolvePath(context.repoRoot, provenanceFile))

				if (!provenanceMatches(committed, record)) {
					diagnostics.push({
						severity: DiagnosticSeverity.Error,
						message: `${provenanceFile} differs from what package.json and model-card.json state — ${REGENERATE}`,
						file: provenanceFile,
						line: null,
						details: null,
					})
				}
			} catch {
				diagnostics.push({
					severity: DiagnosticSeverity.Error,
					message: `${provenanceFile} is missing or unparseable, so the package records no provenance — ${REGENERATE}`,
					file: provenanceFile,
					line: null,
					details: null,
				})
			}

			const manifest = await readPackageJSON(resolvePath(context.repoRoot, record.workspace, "package.json"))
			const declared = new Set(Array.isArray(manifest.files) ? manifest.files : [])

			for (const generated of [LICENSE_FILE, PROVENANCE_FILE]) {
				if (declared.has(generated)) continue

				diagnostics.push({
					severity: DiagnosticSeverity.Error,
					message: `${record.workspace}/package.json does not declare ${generated} in "files", so the published tarball omits it`,
					file: `${record.workspace}/package.json`,
					line: null,
					details: null,
				})
			}
		}

		return diagnostics
	},
}
