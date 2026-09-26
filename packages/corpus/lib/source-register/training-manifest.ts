/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The frozen record of which sources contributed rows to one corpus build, and under which terms.
 *
 *   Its digest is over the manifest with `contentDigest` emptied, so two builds over identical inputs
 *   produce the same digest and any change to a source, its elected grant, its row count or the recipe
 *   changes it.
 */

import { sha256Hex } from "@mailwoman/core/hash"
import { stringifyJSON } from "@mailwoman/core/json"

import { LicenseReviewState, type LicenseDecision, type SourceOperation } from "#source-register/types"

/**
 * What one source contributed to one build, and what had been established
 * about its terms when the build ran.
 */
export interface TrainingSourceRecord {
	/**
	 * The adapter id stamped into every row's `source`, and the join key to the register's `sourceID`.
	 */
	source: string
	/**
	 * Rows this source contributed after license exclusion and eligibility but
	 * before augmentation; a synthetic row counts under the source it was fanned from.
	 */
	rows: number
	license: string
	/**
	 * The register's decision for that license when the build ran, or `null`
	 * when the register named no decision for it.
	 */
	decision: {
		licenseID: string
		state: LicenseReviewState
		electedTerms: string | null
		/**
		 * The operations the elected grant permitted at build time; an operation absent here
		 * was `unreviewed` or `refused`, which the decision records separately.
		 */
		permitted: SourceOperation[]
	} | null
}

/**
 * One corpus build's frozen source record.
 */
export interface TrainingManifest {
	manifestID: "corpus-training-manifest"
	schemaVersion: 1
	corpusVersion: string
	builtAt: string
	/**
	 * The build profile, so a reader can tell a corpus whose sources were checked
	 * from one whose sources were not.
	 */
	profile: string
	/**
	 * Sources in descending row order.
	 */
	sources: TrainingSourceRecord[]
	/**
	 * Sources the build refused, with the reasons, so the record shows what was
	 * left out as well as what went in.
	 */
	refused: Record<string, readonly string[]>
	totalRows: number
	/**
	 * Sha256 over this manifest with `contentDigest` emptied.
	 */
	contentDigest: string
}

/**
 * The digest a manifest should carry, computed over the manifest with its digest field emptied.
 */
export function trainingManifestDigest(manifest: TrainingManifest): string {
	return sha256Hex(stringifyJSON({ ...manifest, contentDigest: "" }))
}

/**
 * Freeze one build's source observations into a manifest.
 *
 * A license the decision table does not carry records `decision: null` rather than being omitted,
 * so a build that read an unregistered adapter stays distinguishable from one that read no source.
 */
export function freezeTrainingManifest(input: {
	corpusVersion: string
	builtAt: string
	profile: string
	rowsBySource: ReadonlyMap<string, { rows: number; license: string }>
	decisionsByLicense: ReadonlyMap<string, LicenseDecision>
	refused: ReadonlyMap<string, readonly string[]>
}): TrainingManifest {
	const sources: TrainingSourceRecord[] = [...input.rowsBySource.entries()]
		.map(([source, { rows, license }]): TrainingSourceRecord => {
			const decision = input.decisionsByLicense.get(license)

			return {
				source,
				rows,
				license,
				decision: decision
					? {
							licenseID: decision.licenseID,
							state: decision.state,
							electedTerms: decision.state === LicenseReviewState.Elected ? decision.electedTerms : null,
							permitted:
								decision.state === LicenseReviewState.Elected
									? Object.entries(decision.operations ?? {})
											.filter(([, reading]) => reading.permission === "permitted")
											.map(([operation]) => operation as SourceOperation)
											.toSorted()
									: [],
						}
					: null,
			}
		})
		.toSorted((left, right) => right.rows - left.rows || left.source.localeCompare(right.source))

	const manifest: TrainingManifest = {
		manifestID: "corpus-training-manifest",
		schemaVersion: 1,
		corpusVersion: input.corpusVersion,
		builtAt: input.builtAt,
		profile: input.profile,
		sources,
		refused: Object.fromEntries([...input.refused.entries()].toSorted(([a], [b]) => a.localeCompare(b))),
		totalRows: sources.reduce((total, record) => total + record.rows, 0),
		contentDigest: "",
	}

	return { ...manifest, contentDigest: trainingManifestDigest(manifest) }
}

/**
 * Everything wrong with a training manifest, one message per problem; the digest
 * check is what makes the record frozen rather than merely written.
 */
export function auditTrainingManifest(manifest: TrainingManifest): string[] {
	const problems: string[] = []

	if (manifest.contentDigest !== trainingManifestDigest(manifest)) {
		problems.push("the manifest's content digest does not match its contents, so something edited it after its build")
	}

	const counted = manifest.sources.reduce((total, record) => total + record.rows, 0)

	if (counted !== manifest.totalRows) {
		problems.push(`the manifest totals ${manifest.totalRows} rows and its sources carry ${counted}`)
	}

	const seen = new Set<string>()

	for (const record of manifest.sources) {
		if (seen.has(record.source)) {
			problems.push(`source ${stringifyJSON(record.source)} appears more than once`)
		}

		seen.add(record.source)

		if (record.rows <= 0) {
			problems.push(`source ${stringifyJSON(record.source)} contributed ${record.rows} rows and should not be listed`)
		}
	}

	return problems
}

/**
 * The sources in a manifest whose terms did not permit an operation
 * when the build ran, with the reason for each.
 */
export function sourcesNotPermitting(
	manifest: TrainingManifest,
	operation: SourceOperation
): Array<{ source: string; because: string }> {
	const blocking: Array<{ source: string; because: string }> = []

	for (const record of manifest.sources) {
		if (!record.decision) {
			blocking.push({
				source: record.source,
				because: `the register carried no decision for license ${stringifyJSON(record.license)} when the corpus was built`,
			})

			continue
		}

		if (record.decision.state !== LicenseReviewState.Elected) {
			blocking.push({
				source: record.source,
				because: `its license decision read ${record.decision.state} when the corpus was built`,
			})

			continue
		}

		if (!record.decision.permitted.includes(operation)) {
			blocking.push({
				source: record.source,
				because: `the elected terms ${stringifyJSON(record.decision.electedTerms ?? "")} did not permit ${operation}`,
			})
		}
	}

	return blocking
}
