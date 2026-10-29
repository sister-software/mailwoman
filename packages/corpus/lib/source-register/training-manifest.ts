/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The frozen record of sources that contributed rows to one corpus build.
 *   It also records the applicable terms.
 *
 *   Its digest is over the manifest with `contentDigest` emptied, so two builds over identical inputs
 *   produce the same digest. A change to a source, its elected grant, row count or recipe changes the digest.
 */

import { sha256Hex } from "@mailwoman/core/hash"
import { stringifyJSON } from "@mailwoman/core/json"
import { LicenseReviewState, type LicenseDecision } from "@mailwoman/core/license/decision"

import { mappingInputsFor, type CorpusSourceInputs } from "#source-register/corpus-inputs"
import { inputDecisions } from "#source-register/row-license"
import type { SourceOperation } from "#source-register/types"

/**
 * The license label recorded for a source whose rows carry no label.
 *
 * A recipe in a corpus built before #2741 could write rows with an empty `license` column.
 * A current writer stamps the register's id and refuses a source that has none,
 * so only an older file reaches this label.
 *
 * An empty string in the record would read as a source that carries no terms,
 * and `summarizeLicense` would find no identifier in it and report no obligation.
 *
 * This label is unrecognized by design, so every reader reports the source's
 * terms as unknown rather than as none.
 */
export const NO_LICENSE_RECORDED = "none-recorded-on-rows"

/**
 * What one source contributed to a build.
 *
 * Also records what the build had established about its terms.
 */
export interface TrainingSourceRecord {
	/**
	 * The adapter id stamped into every row's `source`, and the join key to the register's `sourceID`.
	 */
	source: string
	/**
	 * Rows this source contributed after license exclusion and eligibility but before augmentation.
	 * A synthetic row counts under the source it was fanned from.
	 */
	rows: number
	/**
	 * The license label the source's rows carry.
	 *
	 * When the rows carry more than one label, this is the label on most of them
	 * and {@linkcode licenseValues} lists every label with its rows.
	 */
	license: string
	/**
	 * Every license label the source's rows carry, with the rows under each, when there is more than one.
	 *
	 * A recipe stamps a description of its own output into the column, and one recipe can stamp
	 * several, so a synthetic source reads several labels where an adapter's source reads one.
	 * The record keeps the whole set because a reader that saw only {@linkcode license}
	 * would take the majority label for the terms of every row.
	 */
	licenseValues?: Record<string, number>
	/**
	 * The register's decisions for the source's register inputs when the build ran, combined
	 * by {@linkcode combineSourceDecisions}, or `null` when they could not all be found.
	 *
	 * The inputs are the ones `corpus-source-inputs.json` maps the source to, so the
	 * decision is found through the mapping rather than through {@linkcode license}.
	 */
	decision: TrainingSourceDecision | null
	/**
	 * Why {@linkcode decision} is `null`.
	 *
	 * A record frozen before the decision was resolved through the mapping has a `null` decision and no
	 * gap, and reads as a decision the freeze never looked up rather than as one the register lacked.
	 */
	decisionGap?: TrainingDecisionGap
}

/**
 * What one register decision said at build time.
 */
export interface TrainingInputDecision {
	licenseID: string
	state: LicenseReviewState
	electedTerms: string | null
	/**
	 * The operations the elected grant permitted at build time.
	 *
	 * An operation absent here was `unreviewed` or `refused`, which the decision records separately.
	 */
	permitted: SourceOperation[]
}

/**
 * The decisions over one source's register inputs, combined.
 */
export interface TrainingSourceDecision extends TrainingInputDecision {
	/**
	 * Each decision the combination read, in `licenseID` order, when there is more than one.
	 *
	 * A combined `state` names one state where the inputs can hold several,
	 * such as an elected grant beside an unchecked one, and the record is frozen
	 * so a reader cannot look the others up as they stood at build time.
	 */
	inputs?: TrainingInputDecision[]
}

/**
 * Why a source's decision could not be found.
 */
export const TrainingDecisionGapReason = {
	/**
	 * `corpus-source-inputs.json` does not map the source.
	 */
	Unmapped: "unmapped",
	/**
	 * The mapping lists only authored inputs, so no register decision covers the rows.
	 */
	NoRegisterInput: "no-register-input",
	/**
	 * The mapping points at a `licenseID` the register does not declare.
	 */
	MissingDecision: "missing-decision",
} as const

export type TrainingDecisionGapReason = (typeof TrainingDecisionGapReason)[keyof typeof TrainingDecisionGapReason]

export type TrainingDecisionGap =
	| { reason: typeof TrainingDecisionGapReason.Unmapped | typeof TrainingDecisionGapReason.NoRegisterInput }
	| {
			reason: typeof TrainingDecisionGapReason.MissingDecision
			/**
			 * Each `licenseID` the mapping names and the register lacks.
			 */
			licenseIDs: string[]
	  }

/**
 * The register decisions and the source table a freeze resolves each source's decision through.
 */
export interface SourceDecisionTable {
	/**
	 * The register's license decisions keyed by `licenseID`.
	 */
	decisions: ReadonlyMap<string, LicenseDecision<SourceOperation>>
	inputs: CorpusSourceInputs
}

function inputDecisionRecord(decision: LicenseDecision<SourceOperation>): TrainingInputDecision {
	return {
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
}

/**
 * Combines the decisions over one source's register inputs into one record.
 *
 * The combination is elected only when every decision is elected.
 * Otherwise it reads `refused` when any decision is refused, and the first other
 * state in `licenseID` order when none is.
 *
 * `permitted` is the intersection of every decision's permitted operations,
 * so an operation counts only when every input's grant permits it.
 * `licenseID` and `electedTerms` list every decision's value joined by ` AND `,
 * the SPDX expression for terms that all apply.
 * `electedTerms` is `null` unless every decision is elected.
 *
 * @throws When `decisions` is empty, because a combination needs at least one decision to state.
 */
export function combineSourceDecisions(decisions: readonly LicenseDecision<SourceOperation>[]): TrainingSourceDecision {
	const records = decisions.map(inputDecisionRecord).toSorted((a, b) => a.licenseID.localeCompare(b.licenseID))
	const [first, ...rest] = records

	if (!first) throw new Error("combineSourceDecisions needs at least one decision")

	if (!rest.length) return first

	const blocking =
		records.find((record) => record.state === LicenseReviewState.Refused) ??
		records.find((record) => record.state !== LicenseReviewState.Elected)

	return {
		licenseID: records.map((record) => record.licenseID).join(" AND "),
		state: blocking?.state ?? LicenseReviewState.Elected,
		electedTerms: blocking ? null : records.map((record) => record.electedTerms).join(" AND "),
		permitted: first.permitted.filter((operation) => rest.every((record) => record.permitted.includes(operation))),
		inputs: records,
	}
}

/**
 * The decision one source's record holds, or the gap that stopped it from being found.
 *
 * `corpusVersion` selects a mapping's `history` entry when one lists the corpus, as the release audit does.
 */
export function resolveSourceDecision(
	source: string,
	table: SourceDecisionTable,
	corpusVersion?: string
): { decision: TrainingSourceDecision } | { decision: null; decisionGap: TrainingDecisionGap } {
	const resolved = table.inputs.resolve(source)

	if (!resolved) return { decision: null, decisionGap: { reason: TrainingDecisionGapReason.Unmapped } }

	const { found, missing } = inputDecisions(mappingInputsFor(resolved.mapping, corpusVersion), table.decisions)

	if (missing.length) {
		return {
			decision: null,
			decisionGap: {
				reason: TrainingDecisionGapReason.MissingDecision,
				licenseIDs: [...new Set(missing.map((input) => input.license))].toSorted(),
			},
		}
	}

	if (!found.length) return { decision: null, decisionGap: { reason: TrainingDecisionGapReason.NoRegisterInput } }

	return { decision: combineSourceDecisions(found) }
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
	 *
	 * Each key is `<adapter id>:<ISO 3166-1 alpha-2>`, the pair that addresses one register source,
	 * because one adapter can emit several jurisdictions and each has its own license decision.
	 */
	refused: Record<string, readonly string[]>
	totalRows: number
	/**
	 * Sha256 over this manifest with `contentDigest` emptied.
	 */
	contentDigest: string
}

/**
 * The digest a manifest should include, computed over the manifest with its digest field emptied.
 */
export function trainingManifestDigest(manifest: TrainingManifest): string {
	return sha256Hex(stringifyJSON({ ...manifest, contentDigest: "" }))
}

/**
 * Freeze one build's source observations into a manifest.
 *
 * Each source's decision is resolved through its register inputs in `decisionTable.inputs`
 * by {@linkcode resolveSourceDecision}.
 * A source whose decision cannot be found records `decision: null` with the
 * {@linkcode TrainingDecisionGap} that stopped it rather than being omitted, so a build
 * that read an unmapped source stays distinguishable from one that read no source.
 */
export function freezeTrainingManifest(input: {
	corpusVersion: string
	builtAt: string
	profile: string
	rowsBySource: ReadonlyMap<string, { rows: number; license: string; licenseValues?: Record<string, number> }>
	decisionTable: SourceDecisionTable
	refused: ReadonlyMap<string, readonly string[]>
}): TrainingManifest {
	const sources: TrainingSourceRecord[] = [...input.rowsBySource.entries()]
		.map(([source, { rows, license, licenseValues }]): TrainingSourceRecord => ({
			source,
			rows,
			license,
			...(licenseValues ? { licenseValues } : {}),
			...resolveSourceDecision(source, input.decisionTable, input.corpusVersion),
		}))
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
 * The digest check is what makes the record frozen rather than merely written.
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
 * Why a record with no decision blocks an operation, in the words of its gap,
 * or `null` for a gap that leaves every operation unblocked.
 */
function decisionGapReason(record: TrainingSourceRecord): string | null {
	const gap = record.decisionGap

	if (!gap) {
		return (
			`the record holds no decision for license ${stringifyJSON(record.license)} and no reason, because it was ` +
			"frozen before decisions were resolved through corpus-source-inputs.json"
		)
	}

	switch (gap.reason) {
		case TrainingDecisionGapReason.Unmapped:
			return "corpus-source-inputs.json did not map the source when the corpus was built"
		case TrainingDecisionGapReason.NoRegisterInput:
			return null
		case TrainingDecisionGapReason.MissingDecision:
			return (
				`the register carried no decision for license ${gap.licenseIDs.map((id) => stringifyJSON(id)).join(", ")} ` +
				"when the corpus was built"
			)
	}
}

/**
 * The sources in a manifest whose terms did not permit an operation
 * when the build ran, with the reason for each.
 *
 * A source recorded with a {@linkcode TrainingDecisionGapReason.NoRegisterInput} gap is
 * not listed: every input reaching its rows was written in this repository, so no third
 * party's terms apply, and `sourceRightsGaps` admits it into a build on the same reading.
 */
export function sourcesNotPermitting(
	manifest: TrainingManifest,
	operation: SourceOperation
): Array<{ source: string; because: string }> {
	const blocking: Array<{ source: string; because: string }> = []

	for (const record of manifest.sources) {
		if (!record.decision) {
			const because = decisionGapReason(record)

			if (because) {
				blocking.push({ source: record.source, because })
			}

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
