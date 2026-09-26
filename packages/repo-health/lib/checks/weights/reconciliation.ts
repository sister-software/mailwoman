/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Every number a published weights package states about itself agrees with the others.
 *
 *   A package carries four version-shaped facts across three files, and no check compared them. The manifest's
 *   `version`, the model card's `version`, the base package a `mailwoman.baseWeights` names and the version that base
 *   actually carries, and the digests a card records against the artifacts a manifest declares. Each is written by a
 *   different step, and a disagreement between any two is silent: the compiler reads none of them, and a tarball ships
 *   whatever the files say.
 *
 *   This check is the reconciliation P4 asks for. It refuses a disagreement rather than repairing one, because the
 *   repair differs by case: a stale card version is a release step that did not run, a base naming a package that does
 *   not exist is a manifest edit, and a digest against an artifact the manifest stopped declaring is a card that
 *   describes an older tarball.
 *
 *   It does not compare a card version against a manifest version. Those are two series by design — `en-us` ships npm
 *   10.0.0 carrying model 9.1.0 — and `docs/records/site-2026-08/releases.mdx` records which release changed the model
 *   and which did not.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { readPackageJSON } from "@mailwoman/core/module/resolve-from"
import { weightsRightsRecords } from "@mailwoman/release-kit/weights/rights/write"
import { resolvePath } from "path-ts"

import { type Diagnostic, DiagnosticSeverity, type RepoCheck } from "#check"

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

			// A base this repository does not publish cannot be resolved by a consumer either,
			// and the overlay's inherited lineage reads unresolved rather than empty.
			if (record.baseWeights && !versionByPackage.has(record.baseWeights)) {
				diagnostics.push({
					severity: DiagnosticSeverity.Error,
					message: `${record.packageName} declares mailwoman.baseWeights ${record.baseWeights}, which is not a published weights package`,
					file,
				})
			}

			if (record.inherited?.unresolved) {
				diagnostics.push({
					severity: DiagnosticSeverity.Error,
					message: `${record.packageName}'s inherited lineage is unresolved: ${record.inherited.unresolved}`,
					file,
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

			// A digest against an artifact the manifest no longer declares describes a tarball this
			// package stopped shipping, and a reader checking it would find no artifact to check.
			//
			// A `$`-prefixed key is the annotation convention these cards use throughout —
			// `$comment`, `$comment_661` — and names no file.
			// Reading one as a filename would report a defect in every card that documents itself.
			for (const digested of Object.keys(card.files_md5 ?? {})) {
				if (digested.startsWith("$")) continue

				if (declared.has(digested)) continue

				diagnostics.push({
					severity: DiagnosticSeverity.Error,
					message: `${cardPath} records a digest for ${digested}, which ${record.workspace}/package.json does not declare in "files"`,
					file: cardPath,
				})
			}

			const manifest = await readPackageJSON(resolvePath(context.repoRoot, record.workspace, "package.json"))

			// A package declaring a base and shipping its own graph is two claims about
			// where its rows are decoded, and `resolveWeights` reads one of them.
			if (record.baseWeights && Array.isArray(manifest.files) && manifest.files.includes("model.onnx")) {
				diagnostics.push({
					severity: DiagnosticSeverity.Error,
					message: `${record.packageName} declares a base and also ships model.onnx — an overlay decodes through its base's graph`,
					file,
				})
			}
		}

		return diagnostics
	},
}
