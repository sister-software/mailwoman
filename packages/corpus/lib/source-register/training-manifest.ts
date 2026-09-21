/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The frozen record of which sources contributed rows to one corpus build, and under which terms.
 *
 *   A model card names its corpus as a sentence of prose rather than as an identifier, and that sentence cannot be
 *   joined to anything. So a release path has no way to ask what a model was trained on, and the per-package
 *   `PROVENANCE.json` reports the question unresolved rather than answering it.
 *
 *   This is the record that answers it. It is written by the build that produced the corpus, from what that build
 *   observed rather than from what the register holds today, and it is frozen: the register's contents move as somebody
 *   reviews terms, and a manifest re-derived from the register tomorrow would describe a build that never happened.
 *
 *   Its digest is over the manifest without the digest field, the same shape the source register uses, so two builds
 *   over identical inputs produce the same digest and any change to a source, its elected grant, its row count or the
 *   recipe changes it.
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
	 * The adapter id stamped into every row's `source`.
	 *
	 * This is the join key to the register's `sourceID` where the register carries one.
	 */
	source: string
	/**
	 * Rows this source contributed after license exclusion and eligibility, before augmentation.
	 *
	 * A synthetic row is counted under the source it was fanned from rather than as a source of its own.
	 */
	rows: number
	/**
	 * The `license` string the adapter stamped on those rows.
	 */
	license: string
	/**
	 * The register's decision for that license when the build ran, or `null`
	 * when the register named no decision for it.
	 *
	 * `null` is the ordinary case for an adapter whose id is not a register source.
	 */
	decision: {
		licenseID: string
		state: LicenseReviewState
		electedTerms: string | null
		/**
		 * The operations the elected grant permitted at build time.
		 *
		 * An operation absent from this list was `unreviewed` or `refused`, which are different
		 * answers and both recorded on the decision rather than flattened here.
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
	 * Sources in descending row order, so the largest contributor reads first.
	 */
	sources: TrainingSourceRecord[]
	/**
	 * Sources the build refused, with the reasons.
	 *
	 * Kept beside the included ones because a release record has to show what
	 * was left out as well as what went in.
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
 * `decisionsByLicense` is the register's decision table as the build read it.
 * A license the table does not carry records `decision: null` rather than being omitted:
 * the row count is an observation either way, and dropping the source would make a build
 * that read an unregistered adapter indistinguishable from one that read nothing.
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
 * Everything wrong with a training manifest, one message per problem.
 *
 * The digest check is what makes the record frozen rather than merely written:
 * a manifest edited after its build fails here, which is the failure the source
 * register's own digest exists to catch (#2352).
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
 *
 * This is what a publication path asks before redistributing a model trained on the corpus.
 * A source whose decision is `null`, whose state is anything but `elected`,
 * or whose elected grant never named the operation, is returned.
 *
 * The three are different situations and each message says which.
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
