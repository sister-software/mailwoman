/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Every number a published weights package states about itself agrees with the others.
 *
 * A card version and a manifest version are two series by design, so this check does not compare them.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { readPackageJSON } from "@mailwoman/core/module/resolve-from"
import { resolvePath } from "path-ts"

import { weightsRightsRecords } from "#release-kit/weights/rights/write"
import { type Diagnostic, DiagnosticSeverity, type RepoCheck } from "#repo-health/check"

interface ModelCard {
	files_md5?: Record<string, unknown>
}

/**
 * The `weights-reconciliation` check: one error per disagreement between a package's own statements.
 */
export const weightsReconciliationCheck: RepoCheck = {
	id: "weights-reconciliation",
	description: "Every published weights package's versions, base pointer and recorded digests agree with each other.",
	async run(context) {
		const diagnostics: Diagnostic[] = []
		const records = await weightsRightsRecords(context.repoRoot)
		const versionByPackage = new Map(records.map((record) => [record.packageName, record.packageVersion]))

		for (const record of records) {
			const file = `${record.workspace}/package.json`

			// A consumer cannot resolve a base that this repository does not publish.
			// The overlay's inherited lineage reports it as unresolved instead of empty.
			if (record.baseWeights && !versionByPackage.has(record.baseWeights)) {
				diagnostics.push({
					severity: DiagnosticSeverity.Error,
					message: `${record.packageName} declares mailwoman.baseWeights ${record.baseWeights}, which is not a published weights package`,
					file,
					line: null,
					details: null,
				})
			}

			if (record.inherited?.unresolved) {
				diagnostics.push({
					severity: DiagnosticSeverity.Error,
					message: `${record.packageName}'s inherited lineage is unresolved: ${record.inherited.unresolved}`,
					file,
					line: null,
					details: null,
				})
			}

			// Every workspace releases in lockstep, so an overlay pinned to a base at
			// another version means the release did not land whole and a tarball would
			// freeze `workspace:*` against the wrong sibling.
			if (record.baseWeights) {
				const baseVersion = versionByPackage.get(record.baseWeights)

				if (baseVersion && baseVersion !== record.packageVersion) {
					diagnostics.push({
						severity: DiagnosticSeverity.Error,
						message: `${record.packageName} is at ${record.packageVersion} and its base ${record.baseWeights} is at ${baseVersion} — every workspace releases in lockstep`,
						file,
						line: null,
						details: null,
					})
				}
			}

			const declared = new Set(record.artifacts.map((artifact) => artifact.path))
			const cardPath = `${record.workspace}/model-card.json`

			let card: ModelCard

			try {
				card = await readLocalJSONFile<ModelCard>(resolvePath(context.repoRoot, cardPath))
			} catch {
				continue
			}

			// A digest for an artifact the manifest no longer declares describes a
			// tarball this package stopped shipping.
			//
			// A `$`-prefixed key is the annotation convention these cards use and names no file,
			// so reading one as a filename would report a defect in every card that documents itself.
			for (const digested of Object.keys(card.files_md5 ?? {})) {
				if (digested.startsWith("$")) continue

				if (declared.has(digested)) continue

				diagnostics.push({
					severity: DiagnosticSeverity.Error,
					message: `${cardPath} records a digest for ${digested}, which ${record.workspace}/package.json does not declare in "files"`,
					file: cardPath,
					line: null,
					details: null,
				})
			}

			const manifest = await readPackageJSON(resolvePath(context.repoRoot, record.workspace, "package.json"))

			// A declared base and a shipped graph make conflicting claims about where rows are decoded.
			// `resolveWeights` follows one of those claims.
			if (record.baseWeights && Array.isArray(manifest.files) && manifest.files.includes("model.onnx")) {
				diagnostics.push({
					severity: DiagnosticSeverity.Error,
					message: `${record.packageName} declares a base and also ships model.onnx — an overlay decodes through its base's graph`,
					file,
					line: null,
					details: null,
				})
			}
		}

		return diagnostics
	},
}
