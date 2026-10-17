/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Render a weights package's two rights files from its {@link WeightsRightsRecord}.
 *   `LICENSE.md` states the terms this repository grants. `PROVENANCE.json` records artifact sources and unresolved facts.
 *
 *   Neither file asserts clearance. `PROVENANCE.json` records the model card's statements and marks other facts
 *   unresolved. `LICENSE.md` states that the commercial grant excludes third-party inputs.
 */

import { isIdentical } from "@mailwoman/core/identical"
import type { RequiredAttribution } from "@mailwoman/corpus/source-register"

import { describeModelGraph } from "#release-kit/weights/rights/model-graph"
import { declaresOpenStreetMapAttribution } from "#release-kit/weights/rights/osm-ancestry"
import type { AttributionRecord, WeightsRightsRecord } from "#release-kit/weights/rights/record"

/**
 * The name of the generated obligations file inside a weights workspace.
 */
export const LICENSE_FILE = "LICENSE.md"

/**
 * The name of the generated machine-readable provenance file inside a weights workspace.
 */
export const PROVENANCE_FILE = "PROVENANCE.json"

/**
 * The provenance record as it is written to disk.
 *
 * Field names are snake_case to match `model-card.json`, which is the file a
 * reader of this one will open next.
 */
export interface ProvenanceDocument {
	$comment: string
	package: string
	package_version: string
	license: string
	model_card_version: string | null
	version_series: string
	version_series_meaning: string
	base_weights: string | null
	/**
	 * What this package inherits by decoding through another package's graph.
	 *
	 * `null` for a graph package.
	 */
	inherited_lineage: {
		package: string
		package_version: string
		model_card_version: string | null
		chain: string[]
		note: string
		attribution: Array<{ text: string; license_named: string | null }>
		/**
		 * The attributions the base's effective training manifest records as owed,
		 * repeated for a consumer who installs this overlay alone.
		 * Empty when the base has no such manifest.
		 */
		required_attributions: RequiredAttributionEntry[]
		unresolved: string | null
	} | null
	artifacts: Array<{ path: string; role: string; md5: string | null; digest: string }>
	/**
	 * What this package's own model graph emits, read from the `.onnx` file at generation time.
	 *
	 * `null` for a package shipping no graph of its own, such as an overlay that decodes through its base.
	 * `text_emitting_output` answers what running the model returns.
	 *
	 * It settles no question about a white-box extraction attack over the weights.
	 */
	model_graph: {
		format: string
		outputs: Array<{ name: string; type: string; shape: Array<number | string> }>
		text_emitting_output: boolean
		summary: string
		unreadable: string | null
	} | null
	training_attribution: {
		status: "recorded" | "none-recorded-in-this-package"
		entries: Array<{ text: string; license_named: string | null; uses: string[] }>
		/**
		 * The number of entries that state each use.
		 *
		 * An entry may state more than one, so these do not sum to the entry count.
		 */
		by_use: Record<string, number>
	}
	attribution_recorded_in_another_package: Array<{ artifact: string; recorded_in: string; text: string }>
	corpus_version: string | null
	/**
	 * Which of the corpus's sources one config's audited epoch drew from, read from the
	 * effective training manifest committed under `packages/corpus/data/training-manifests/`.
	 *
	 * `corpus_version` identifies the corpus.
	 * The corpus manifest states what it holds.
	 *
	 * Neither states what reached the trainer.
	 * The two differ by the country filter and source weights, a zero weight, the sampler
	 * and every overlay merged after the corpus manifest was written.
	 * This block describes the difference.
	 *
	 * `null` means the repository holds no effective manifest for the corpus recorded by this card.
	 * This describes the checkout rather than the model.
	 */
	effective_training_sources: {
		config: string
		seed: number
		draws_realized: number
		/**
		 * Sources the audited epoch drew rows from, with the rows it emitted for each after augmentation.
		 */
		drew: Array<{ source: string; license: string; corpus_rows: number; emitted_rows: number }>
		/**
		 * Sources the corpus holds that the epoch drew no row from, with why.
		 */
		excluded: Array<{ source: string; because: string }>
		/**
		 * Sources the epoch emitted that the corpus manifest does not name, each at its three stages.
		 *
		 * `corpus_rows` counts rows of the source in the corpus.
		 * `drawn_rows` counts rows sampled by the epoch.
		 *
		 * `emitted_rows` counts rows that reached the trainer after augmentation.
		 * A non-empty list means this block covers part of the training data, because the
		 * corpus manifest records the terms of none of these sources.
		 *
		 * `corpus_rows` reads `-1` when the audit reported no count for the source.
		 */
		emitted_but_unrecorded: Array<{
			source: string
			corpus_rows: number
			drawn_rows: number
			emitted_rows: number
		}>
		total_emitted_rows: number
	} | null
	/**
	 * The attributions the audited epoch's sources owe, grouped by the license label their rows carry.
	 *
	 * A recorded `statement` is the text to reproduce.
	 * A `null` statement means the label requires attribution and the text is written
	 * from each source's register entry or the card's own attribution entries.
	 *
	 * A label this repository does not recognize is listed too, because an unrecognized
	 * license's obligations are unknown rather than absent.
	 *
	 * `null` when no effective training manifest is committed for the corpus the card records.
	 */
	required_attributions: RequiredAttributionEntry[] | null
	tokenizer_version: string | null
	unresolved: string[]
}

/**
 * One attribution entry as the provenance document prints it.
 */
interface RequiredAttributionEntry {
	license: string
	sources: string[]
	statement: string | null
}

function requiredAttributionEntries(attributions: readonly RequiredAttribution[]): RequiredAttributionEntry[] {
	return attributions.map((entry) => ({
		license: entry.license,
		sources: [...entry.sources],
		statement: entry.statement,
	}))
}

const GENERATED_BY =
	"Generated by `mwops release write-rights-files` from package.json and model-card.json. Edit the generator or those files, never this one."

const SERIES_MEANING: Readonly<Record<string, string>> = {
	model:
		"This package ships a model graph, and model_card_version names the trained model. It is a different series from package_version, which moves in lockstep across every mailwoman workspace on every release. `mwops release verify-metadata` keys the score ledger and release documentation off this number.",
	overlay:
		"This package is a data-only overlay, and model_card_version names this overlay's own artifacts. The model graph its rows decode through is the one base_weights names, at that package's own model_card_version. Neither number is package_version, which moves in lockstep across every mailwoman workspace on every release.",
}

/**
 * The questions this record leaves open, each phrased as the question rather than as a finding.
 *
 * A reader must distinguish a package with no recorded training inputs from one trained on no inputs.
 * The reader must also distinguish an artifact with no recorded digest from one whose digest was checked.
 */
function unresolvedQuestions(record: WeightsRightsRecord): string[] {
	const questions: string[] = []
	const undigested = record.artifacts.filter((artifact) => artifact.digest === "unrecorded")

	if (undigested.length) {
		questions.push(
			`No digest is recorded for ${undigested.length} of ${record.artifacts.length} declared artifacts: ${undigested
				.map((artifact) => artifact.path)
				.join(", ")}. An unrecorded digest is not a verified one.`
		)
	}

	if (!record.attribution.length) {
		questions.push(
			record.inherited?.attribution.length
				? `This package's model card records no training attribution of its own. It ships ${record.artifacts.length} artifacts and no model graph, so its own inputs are unattributed here while the ${record.inherited.attribution.length} entries under inherited_lineage describe ${record.inherited.package}'s graph.`
				: "This package's model card records no training attribution. That states what the card holds, not that the artifacts have no attributable inputs."
		)
	} else if (record.inherited && record.attribution.every((entry) => declaresOpenStreetMapAttribution([entry]))) {
		// An overlay ships no graph, so its OpenStreetMap entry credits the base graph it decodes
		// through, and the card still attributes none of the artifacts the overlay itself ships.
		questions.push(
			`This package's model card attributes only the OpenStreetMap data behind ${record.inherited.package}'s graph. It ships ${record.artifacts.length} artifacts and no model graph, so its own inputs are unattributed here.`
		)
	}

	if (record.inherited?.unresolved) {
		questions.push(`The inherited lineage could not be resolved: ${record.inherited.unresolved}`)
	}

	for (const entry of record.attribution) {
		if (entry.licenseNamed) continue

		questions.push(`One attribution entry names no license: ${entry.text}`)
	}

	// The attribution list combines training, tokenizer and evaluation contributions.
	// The split shows which entries describe rows the model never learned from.
	const evaluationOnly = record.attribution.filter(
		(entry) => entry.uses.includes("evaluation") && !entry.uses.includes("training")
	)

	if (evaluationOnly.length) {
		questions.push(
			`${evaluationOnly.length} of ${record.attribution.length} attribution entries describe evaluation or tokenizer text rather than training rows, so they attribute data this package's model did not learn from: ${evaluationOnly.map((entry) => entry.text.split(":")[0]).join("; ")}.`
		)
	}

	const unstated = record.attribution.filter((entry) => entry.uses.includes("unstated"))

	if (unstated.length) {
		questions.push(
			`${unstated.length} of ${record.attribution.length} attribution entries do not say how the source was used, so whether it trained this model is unrecorded.`
		)
	}

	for (const foreign of record.foreignAttribution) {
		questions.push(
			`${foreign.artifact} ships here, and the entry attributing it sits in ${foreign.recordedIn}'s model card. A consumer installing this package alone receives the artifact without the attribution.`
		)
	}

	if (!record.effectiveTraining) {
		questions.push(
			"Which records trained the model this package ships or inherits is unresolved. `buildCorpus` writes a frozen `TRAINING_SOURCES.json` naming every source that contributed and under which terms, `effective-manifest.run.ts` derives from it and an `audit_epoch_mixture` output what one config's epoch drew, and no released model was built from a corpus carrying either. The corpus named above is the recipe's corpus rather than a record of what reached the model."
		)

		return questions
	}

	const unrecorded = Object.entries(record.effectiveTraining.emittedButUnrecorded)

	if (unrecorded.length) {
		const rows = unrecorded.reduce((sum, [, count]) => sum + count, 0)

		questions.push(
			`effective_training_sources covers part of what trained this model. The audited epoch emitted ${unrecorded.length} source(s) the corpus's frozen manifest does not name, ${rows.toLocaleString()} of ${record.effectiveTraining.totalEmittedRows.toLocaleString()} rows. Those sources reached the corpus through overlays merged after that manifest was written, so their terms are recorded nowhere this document reads.`
		)
	}

	questions.push(
		`effective_training_sources reads one epoch of ${record.effectiveTraining.config} at seed ${record.effectiveTraining.seed}. A training run draws a different sample per epoch, so the source set it names is what one audited epoch drew rather than the union over every epoch the model saw.`
	)

	return questions
}

/**
 * The number of attribution entries that state each use, in a fixed key order
 * so the document is reproducible.
 *
 * A use that no entry states is omitted rather than written as zero, because zero would read as
 * the measurement "no source was used for evaluation" where the truth is that no entry said so.
 */
function countUses(attribution: readonly AttributionRecord[]): Record<string, number> {
	const counts = new Map<string, number>()

	for (const entry of attribution) {
		for (const use of entry.uses) {
			counts.set(use, (counts.get(use) ?? 0) + 1)
		}
	}

	return Object.fromEntries([...counts.entries()].toSorted(([a], [b]) => a.localeCompare(b)))
}

/**
 * The provenance document for one package.
 */
export function renderProvenance(record: WeightsRightsRecord): ProvenanceDocument {
	return {
		$comment: GENERATED_BY,
		package: record.packageName,
		package_version: record.packageVersion,
		license: record.license,
		model_card_version: record.modelCardVersion,
		version_series: record.versionSeries,
		version_series_meaning: SERIES_MEANING[record.versionSeries]!,
		base_weights: record.baseWeights,
		inherited_lineage: record.inherited
			? {
					package: record.inherited.package,
					package_version: record.inherited.packageVersion,
					model_card_version: record.inherited.modelCardVersion,
					chain: record.inherited.chain,
					note: `These entries are ${record.inherited.package}'s record of what its model graph was trained on. This package ships no graph and contributed none of these rows. Read them as the base's lineage rather than as a claim about this package's own artifacts, which are listed under artifacts and attributed under training_attribution.`,
					attribution: record.inherited.attribution.map((entry) => ({
						text: entry.text,
						license_named: entry.licenseNamed,
					})),
					required_attributions: requiredAttributionEntries(record.inherited.requiredAttributions),
					unresolved: record.inherited.unresolved,
				}
			: null,
		artifacts: record.artifacts.map((artifact) => ({
			path: artifact.path,
			role: artifact.role,
			md5: artifact.md5,
			digest: artifact.digest,
		})),
		model_graph: record.modelGraph
			? {
					format: record.modelGraph.format,
					outputs: record.modelGraph.outputs,
					text_emitting_output: record.modelGraph.textEmittingOutput,
					summary: describeModelGraph(record.modelGraph),
					unreadable: record.modelGraph.unreadable,
				}
			: null,
		training_attribution: {
			status: record.attribution.length ? "recorded" : "none-recorded-in-this-package",
			entries: record.attribution.map((entry) => ({
				text: entry.text,
				license_named: entry.licenseNamed,
				uses: entry.uses,
			})),
			by_use: countUses(record.attribution),
		},
		attribution_recorded_in_another_package: record.foreignAttribution.map((foreign) => ({
			artifact: foreign.artifact,
			recorded_in: foreign.recordedIn,
			text: foreign.text,
		})),
		corpus_version: record.corpusVersion,
		effective_training_sources: record.effectiveTraining
			? {
					config: record.effectiveTraining.config,
					seed: record.effectiveTraining.seed,
					draws_realized: record.effectiveTraining.drawsRealized,
					drew: record.effectiveTraining.sources
						.filter((source) => source.excludedBecause === null)
						.map((source) => ({
							source: source.source,
							license: source.license,
							corpus_rows: source.corpusRows,
							emitted_rows: source.emittedRows,
						})),
					excluded: Object.entries(record.effectiveTraining.excludedSources).map(([source, because]) => ({
						source,
						because,
					})),
					emitted_but_unrecorded: Object.entries(record.effectiveTraining.unrecordedSourceStages).map(
						([source, stages]) => ({
							source,
							corpus_rows: stages.corpusRows,
							drawn_rows: stages.drawnRows,
							emitted_rows: stages.emittedRows,
						})
					),
					total_emitted_rows: record.effectiveTraining.totalEmittedRows,
				}
			: null,
		required_attributions: record.effectiveTraining
			? requiredAttributionEntries(record.effectiveTraining.requiredAttributions)
			: null,
		tokenizer_version: record.tokenizerVersion,
		unresolved: unresolvedQuestions(record),
	}
}

/**
 * The attribution section of a package's license file.
 *
 * A graph package reads its own effective training manifest.
 * An overlay reads its base's, because the rows a consumer decodes through
 * the overlay pass through that graph.
 *
 * A package with neither says so, so the absence of a statement reads as an
 * absence of a record rather than of an obligation.
 */
function renderAttributionSection(record: WeightsRightsRecord): string {
	const own = record.effectiveTraining
	const inherited = record.inherited

	const heading = "## Attribution the training data requires"

	if (own) {
		return [
			heading,
			"",
			`The effective training manifest for corpus \`${own.corpusVersion}\` records the sources one audited epoch of`,
			`\`${own.config}\` drew rows from. ${renderAttributionLists(own.requiredAttributions)}`,
		].join("\n")
	}

	if (inherited?.requiredAttributions.length) {
		return [
			heading,
			"",
			`This package decodes through the model graph \`${inherited.package}\` ships, so a consumer of this package`,
			`alone receives rows that graph was trained to read. ${renderAttributionLists(inherited.requiredAttributions)}`,
		].join("\n")
	}

	return [
		heading,
		"",
		"No effective training manifest is committed for the corpus this package's model card records, so the",
		"attributions its training data requires are not derived here. `PROVENANCE.json` lists what the card states.",
	].join("\n")
}

/**
 * The two lists an attribution section prints: statements to reproduce,
 * then labels with no recorded statement.
 */
function renderAttributionLists(attributions: readonly RequiredAttribution[]): string {
	const stated = attributions.filter((entry) => entry.statement)
	const unstated = attributions.filter((entry) => !entry.statement)
	const parts: string[] = []

	if (stated.length) {
		parts.push(
			"Rows under these terms require the statement that follows, reproduced in any redistribution:",
			"",
			...stated.map((entry) => `- ${entry.statement} (\`${entry.license}\`: ${entry.sources.join(", ")})`)
		)
	}

	if (unstated.length) {
		parts.push(
			"",
			"Rows under these labels require attribution, and the statement is written from each source's register",
			"entry or the model card's attribution entries. A label this repository does not recognize is listed because",
			"its obligations are unknown rather than absent:",
			"",
			...unstated.map((entry) => `- \`${entry.license}\`: ${entry.sources.join(", ")}`)
		)
	}

	if (!parts.length) {
		parts.push("None of the sources that reached the trainer carries terms that require attribution.")
	}

	return parts.join("\n")
}

/**
 * Whether a committed provenance document equals the one this record renders, compared as
 * parsed JSON rather than text so the repository formatter may lay the file out as it likes.
 */
export function provenanceMatches(committed: unknown, record: WeightsRightsRecord): boolean {
	return isIdentical(committed, renderProvenance(record))
}

/**
 * The obligations file for one package.
 *
 * It exists per package because npm ships per package, so a consumer who installs
 * one weights overlay finds the terms in its tarball.
 */
export function renderLicenseFile(record: WeightsRightsRecord): string {
	return `# License — ${record.packageName}

${GENERATED_BY}

## The terms Sister Software grants

This package is distributed under \`${record.license}\`.

Under the AGPL-3.0-only branch, three obligations attach: keep the copyright notices, license a
modified copy under the same terms, and offer corresponding source to people who use a modified copy
over a network (section 13). Under a commercial agreement, the source offer and the share-alike
condition do not apply to the code and model artifacts Sister Software authors.

- Open-source terms: https://github.com/sister-software/mailwoman/blob/main/LICENSE.md
- Commercial terms, as executed at checkout: https://mailwoman.ai/license/terms/commercial-2026-10
- Commercial terms, as a reference template that does not itself execute:
  https://github.com/sister-software/mailwoman/blob/main/COMMERCIAL-LICENSE.md

## What the commercial grant does not cover

Section 2 of the commercial agreement limits the grant to the code and model artifacts Sister
Software authors. It does not extend to third-party components distributed with Mailwoman, which
stay under their own licenses. Any attribution or share-alike obligation attaching to those
components continues to apply and is not waived or relicensed by a commercial agreement.

${renderAttributionSection(record)}

## Where the sources are recorded

\`${PROVENANCE_FILE}\` in this package records, per artifact, what the repository holds about its
inputs and which questions it cannot answer. Read it as the record it is: a package with no recorded
training attribution is a package whose model card records none, which is not the same as a package
with no attributable inputs. No artifact in this package is recorded as cleared for any particular
use.

\`THIRD_PARTY_NOTICES.md\` in the repository lists the components Mailwoman distributes and the terms
each one carries. Reference data an operator downloads separately carries the terms of whoever
published it, and nothing here states what those are.
`
}
