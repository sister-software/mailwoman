/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file What reached the trainer, as distinct from what the corpus holds.
 *
 *   `freezeTrainingManifest` records the sources that contributed rows to a corpus. A run then reads that
 *   corpus through a config, and four stages between the two remove rows: `country_weights` rejects a row
 *   whose country it does not name, `source_weights` draws only the sources it lists, a source set to `0.0`
 *   is drawn zero times, and `augment_exclude_sources` withholds a source from augmentation. A model card
 *   quoting the corpus manifest therefore attributes sources the checkpoint never saw.
 *
 *   Measured over `v0.6.0-register-surface` with `v6.0.0-register-surface-60k.yaml` on 2026-09-28: the corpus's
 *   frozen manifest names 11 sources, 9 of which the audited epoch emitted, and the epoch emitted 48 sources
 *   in total. The config admits 136 countries and 40 of them drew rows, so 96 admitted countries drew zero of
 *   the 1,000,000 rows the epoch emitted.
 *
 *   **What this establishes and what it does not.** The counts come from one audited epoch at one seed, so a
 *   source drawn zero times here is one the sampler did not reach in that epoch rather than one no epoch can
 *   reach. The audit reports its seed and draw count, and this record carries both. A source the corpus holds
 *   and the config omits is excluded by construction and reported as such rather than as a zero draw.
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { sha256Hex } from "@mailwoman/core/hash"
import { stringifyJSON } from "@mailwoman/core/json"
import type { PathBuilder } from "path-ts"

import type { TrainingManifest } from "#source-register/training-manifest"

/**
 * Where an `audit_epoch_mixture --json` output for one config is looked for.
 *
 * Under the data root rather than committed, because the file is a measurement of
 * one corpus at one seed and takes about ten minutes to produce.
 * Named by the config so two training arms' audits stay apart, which is the mismatch
 * {@linkcode deriveEffectiveTrainingManifest} refuses.
 */
export function epochMixtureAuditPath(configPath: string): PathBuilder {
	const name =
		configPath
			.split("/")
			.at(-1)
			?.replace(/\.ya?ml$/u, "") ?? configPath

	return dataRootPath("corpus", "epoch-mixture", `${name}.json`)
}

/**
 * Why a source the corpus holds contributed no row to the audited epoch.
 */
export const ExclusionReason = {
	/**
	 * The config's `source_weights` map does not name the source, so the sampler never considers it.
	 */
	UnweightedSource: "unweighted-source",

	/**
	 * `source_weights` names the source at `0.0`.
	 */
	ZeroWeight: "zero-weight",

	/**
	 * The source is weighted and the audited epoch drew zero of its rows.
	 *
	 * This is a statement about one seed and one epoch length rather than about the source.
	 */
	DrewZeroRows: "drew-zero-rows",
} as const

export type ExclusionReason = (typeof ExclusionReason)[keyof typeof ExclusionReason]

/**
 * One source as the audited epoch saw it.
 */
export interface EffectiveSourceRecord {
	source: string

	/**
	 * Rows the corpus holds for this source, from the frozen manifest.
	 */
	corpusRows: number

	license: string

	/**
	 * The weight `source_weights` gives it, or `null` where the map omits it.
	 */
	weight: number | null

	/**
	 * Rows the sampler drew, before augmentation.
	 */
	drawnRows: number

	/**
	 * Rows that survived augmentation and reached the trainer.
	 */
	emittedRows: number

	/**
	 * Whether `augment_exclude_sources` withholds this source from augmentation.
	 */
	augmentExcluded: boolean

	/**
	 * Why it contributed no row, or `null` where it contributed at least one.
	 */
	excludedBecause: ExclusionReason | null
}

/**
 * What one config drew from one corpus in one audited epoch.
 */
export interface EffectiveTrainingManifest {
	manifestID: "corpus-effective-training-manifest"
	schemaVersion: 1

	/**
	 * The corpus the rows came from, and the digest of its own frozen manifest,
	 * so a reader can tell which record this was derived from.
	 */
	corpusVersion: string
	corpusManifestDigest: string

	/**
	 * The config file the audit ran under, as the audit recorded it.
	 */
	config: string

	/**
	 * The seed and draw count of the audited epoch.
	 * Both decide the counts below.
	 */
	seed: number
	drawsRequested: number
	drawsRealized: number

	/**
	 * Countries `country_weights` admits, and how many of them drew a row.
	 */
	admittedCountries: number
	countriesDrawingRows: number

	/**
	 * Countries admitted at a weight that drew zero rows in this epoch.
	 */
	admittedCountriesDrawingZero: string[]

	/**
	 * Every source the corpus holds, in descending emitted order.
	 */
	sources: EffectiveSourceRecord[]

	/**
	 * Sources that reached the trainer, which is the set a model card may attribute as training data.
	 */
	trainingSources: string[]

	/**
	 * Sources the corpus holds that reached no row, each with its reason.
	 */
	excludedSources: Record<string, ExclusionReason>

	/**
	 * Sources the epoch emitted that the corpus's frozen manifest does not name, with their emitted rows.
	 *
	 * `freezeTrainingManifest` runs inside `buildCorpus` and records the base build's sources.
	 * An overlay is merged into the corpus afterwards by `overlay-manifest`,
	 * so its rows are in the corpus and outside that manifest.
	 *
	 * Measured over `v0.6.0-register-surface` on 2026-09-28: the frozen manifest names 11 sources
	 * and the audited epoch emitted 48, of which 39 carry no entry in it.
	 * Those 39 account for 890,666 of the 1,000,000 rows emitted, 89.1%, so the frozen
	 * manifest's license set covers 10.9% of what trained the model.
	 *
	 * Reporting the set is what keeps this record from reading as a complete one.
	 * A release assertion over it has to treat a non-empty value as an unread input
	 * rather than as an absence of rows.
	 */
	emittedButUnrecorded: Record<string, number>

	totalEmittedRows: number

	/**
	 * Sha256 over this manifest with `contentDigest` emptied.
	 */
	contentDigest: string
}

/**
 * The fields this reads from an `audit_epoch_mixture --json` output.
 */
export interface EpochMixtureAudit {
	draw_level?: {
		totals?: Record<string, number>
		by_country?: Record<string, number>
		admitted_countries_drawn?: Record<string, number>
		admitted_countries_drawing_nothing?: string[]
	}
	emitted_level?: { totals?: Record<string, number> }
	meta?: { seed?: number; draws_requested?: number; draws_realized?: number; config?: string }
}

/**
 * The config fields that decide which of a corpus's sources a run reaches.
 */
export interface EffectiveConfigView {
	sourceWeights: Readonly<Record<string, number>>
	augmentExcludeSources: readonly string[]
}

/**
 * Read `data.source_weights` and `data.augment_exclude_sources` from a training config.
 *
 * A line scanner rather than a YAML parse, which is the reading `corpus audit`
 * and the `wire-identifiers` check already apply to the same blocks.
 * The configs are written by hand in a small subset: two-space indentation,
 * one entry per line, `#` comments, and without flow syntax.
 *
 * YAML 1.1 coerces the bare key `NO` to boolean false, and Norway is a
 * `country_weights` key, so a parser would drop it.
 *
 * @throws When the text carries no `source_weights` block.
 * That map decides which sources the sampler considers, and a config without one is
 * a truncated file rather than a config drawing from every source.
 */
export function readConfigView(text: string): EffectiveConfigView {
	const sourceWeights: Record<string, number> = {}
	const augmentExcludeSources: string[] = []

	type ConfigField = "source_weights" | "augment_exclude_sources"

	let field: ConfigField | null = null
	let fieldIndent = -1
	let sawWeights = false

	// oxlint-disable-next-line mailwoman/prefer-spliterator -- one training config, a few hundred lines read whole
	for (const raw of text.split("\n")) {
		if (/^[\t ]*(#|$)/.test(raw)) continue

		const indent = /^[\t ]*/.exec(raw)![0].length

		if (field !== null && indent <= fieldIndent) {
			field = null
		}

		if (field === null) {
			const opener = /^([\t ]*)(source_weights|augment_exclude_sources):\s*(#.*)?$/.exec(raw)

			if (opener) {
				field = opener[2] as ConfigField
				fieldIndent = opener[1]!.length

				if (field === "source_weights") {
					sawWeights = true
				}
			}

			continue
		}

		if (field === "source_weights") {
			const entry = /^[\t ]+([\w-]+):\s*([\d.]+)/.exec(raw)

			if (entry) {
				sourceWeights[entry[1]!] = Number.parseFloat(entry[2]!)
			}

			continue
		}

		const item = /^[\t ]+-\s*([\w-]+)\s*(#.*)?$/.exec(raw)

		if (item) {
			augmentExcludeSources.push(item[1]!)
		}
	}

	if (!sawWeights) {
		throw new Error(
			"the config carries no `data.source_weights` block. That map decides which sources the sampler " +
				"considers, so a config without one is a truncated file rather than a config drawing from every source."
		)
	}

	return { sourceWeights, augmentExcludeSources }
}

/**
 * The digest a manifest should carry, computed over the manifest with its digest field emptied.
 */
export function effectiveManifestDigest(manifest: EffectiveTrainingManifest): string {
	return sha256Hex(stringifyJSON({ ...manifest, contentDigest: "" }))
}

/**
 * Derive what reached the trainer from the corpus's frozen manifest, one audited epoch, and the config.
 *
 * @throws When the audit carries no `emitted_level.totals`.
 * That field is what answers the question, and an audit without it is either
 * a different report or a truncated one.
 * Deriving from `draw_level` alone would attribute rows augmentation removed.
 * @throws When the audit ran under a different config file than the one supplied, because the two are
 * two training arms and one record over both would report a source one of them never weighted.
 */
export function deriveEffectiveTrainingManifest(input: {
	corpusManifest: TrainingManifest
	audit: EpochMixtureAudit
	config: EffectiveConfigView
	configPath: string
}): EffectiveTrainingManifest {
	const emitted = input.audit.emitted_level?.totals

	if (!emitted) {
		throw new Error(
			"the audit carries no `emitted_level.totals`, which is the field that says what reached the trainer. " +
				"Deriving from `draw_level` alone would attribute the rows augmentation removed."
		)
	}

	const audited = input.audit.meta?.config?.split("/").at(-1)
	const wanted = input.configPath.split("/").at(-1)

	if (audited && wanted && audited !== wanted) {
		throw new Error(
			`the audit ran under ${audited} and the config supplied is ${wanted}. Those are two training arms, and ` +
				`one record over both would report a source one of them never weighted.`
		)
	}

	const drawn = input.audit.draw_level?.totals ?? {}
	const admittedDrawn = input.audit.draw_level?.admitted_countries_drawn ?? {}
	const drawingZero = input.audit.draw_level?.admitted_countries_drawing_nothing ?? []
	const augmentExcluded = new Set(input.config.augmentExcludeSources)

	const sources: EffectiveSourceRecord[] = input.corpusManifest.sources.map((record) => {
		const weight = Object.hasOwn(input.config.sourceWeights, record.source)
			? input.config.sourceWeights[record.source]!
			: null

		const drawnRows = drawn[record.source] ?? 0
		const emittedRows = emitted[record.source] ?? 0

		const excludedBecause =
			emittedRows > 0
				? null
				: weight === null
					? ExclusionReason.UnweightedSource
					: weight === 0
						? ExclusionReason.ZeroWeight
						: ExclusionReason.DrewZeroRows

		return {
			source: record.source,
			corpusRows: record.rows,
			license: record.license,
			weight,
			drawnRows,
			emittedRows,
			augmentExcluded: augmentExcluded.has(record.source),
			excludedBecause,
		}
	})

	sources.sort((a, b) => b.emittedRows - a.emittedRows)

	const excludedSources: Record<string, ExclusionReason> = {}

	for (const record of sources) {
		if (record.excludedBecause) {
			excludedSources[record.source] = record.excludedBecause
		}
	}

	const recorded = new Set(input.corpusManifest.sources.map((record) => record.source))
	const emittedButUnrecorded: Record<string, number> = {}

	for (const [source, rows] of Object.entries(emitted)) {
		if (rows > 0 && !recorded.has(source)) {
			emittedButUnrecorded[source] = rows
		}
	}

	const manifest: EffectiveTrainingManifest = {
		manifestID: "corpus-effective-training-manifest",
		schemaVersion: 1,
		corpusVersion: input.corpusManifest.corpusVersion,
		corpusManifestDigest: input.corpusManifest.contentDigest,
		config: input.configPath,
		seed: input.audit.meta?.seed ?? -1,
		drawsRequested: input.audit.meta?.draws_requested ?? 0,
		drawsRealized: input.audit.meta?.draws_realized ?? 0,
		admittedCountries: Object.keys(admittedDrawn).length,
		countriesDrawingRows: Object.values(admittedDrawn).filter((count) => count > 0).length,
		admittedCountriesDrawingZero: [...drawingZero].toSorted(),
		sources,
		trainingSources: sources.filter((record) => record.emittedRows > 0).map((record) => record.source),
		excludedSources,
		emittedButUnrecorded,
		totalEmittedRows: Object.values(emitted).reduce((sum, count) => sum + count, 0),
		contentDigest: "",
	}

	return { ...manifest, contentDigest: effectiveManifestDigest(manifest) }
}

/**
 * Sources a record declares as training data that the audited epoch never reached, and the reverse.
 *
 * A release reads both directions: a declared source the checkpoint never saw overstates what the model
 * learned from, and an emitted source the record omits is an attribution a consumer never receives.
 */
export function provenanceDisagreement(
	manifest: EffectiveTrainingManifest,
	declared: readonly string[]
): { declaredButNotTrained: string[]; trainedButNotDeclared: string[] } {
	const trained = new Set(manifest.trainingSources)
	const named = new Set(declared)

	return {
		declaredButNotTrained: [...named].filter((source) => !trained.has(source)).toSorted(),
		trainedButNotDeclared: [...trained].filter((source) => !named.has(source)).toSorted(),
	}
}

/**
 * Why a release may not assert that a model's declared provenance equals what trained it.
 *
 * An empty array is the only value a caller may read as agreement, and it is reachable only
 * when the effective manifest covers every emitted source.
 * A `null` manifest means no release read one at all, which is reported rather than passed.
 *
 * `declared` is a list of corpus source ids.
 * A caller holding a model card's attribution entries passes `null`.
 *
 * Those entries are prose naming publishers.
 * Every field of the card carries prose rather than a source id, so comparing the two
 * lists as strings reports every entry as a source the epoch never drew.
 *
 * The refusal list then carries the coverage refusal and one line recording the comparison as unmeasured.
 */
export function provenanceRefusals(input: {
	manifest: EffectiveTrainingManifest | null
	declared: readonly string[] | null
	packageName: string
}): string[] {
	if (!input.manifest) {
		return [
			`${input.packageName}: no effective training manifest was read, so whether its declared provenance ` +
				`equals what trained it is unmeasured. \`effective-manifest.run.ts\` writes one from the corpus's ` +
				`frozen manifest and an audit_epoch_mixture output.`,
		]
	}

	const refusals: string[] = []
	const unrecorded = Object.entries(input.manifest.emittedButUnrecorded)

	if (unrecorded.length) {
		const total = unrecorded.reduce((sum, [, rows]) => sum + rows, 0)

		refusals.push(
			`${input.packageName}: the audited epoch emitted ${unrecorded.length} source(s) the corpus's frozen ` +
				`manifest does not name, ${total.toLocaleString()} rows in total, so the effective manifest covers ` +
				`part of what trained the model. Those sources reached the corpus through an overlay merged after ` +
				`the frozen manifest was written: ${unrecorded.map(([source]) => source).join(", ")}.`
		)
	}

	if (input.declared === null) {
		refusals.push(
			`${input.packageName}: whether its declared provenance equals the ${input.manifest.trainingSources.length} ` +
				`source(s) the audited epoch drew from is unmeasured. The model card states its attribution as prose ` +
				`naming publishers, and an effective manifest states corpus source ids, so the two carry no common key.`
		)

		return refusals
	}

	const { declaredButNotTrained, trainedButNotDeclared } = provenanceDisagreement(input.manifest, input.declared)

	if (declaredButNotTrained.length) {
		refusals.push(
			`${input.packageName} declares ${declaredButNotTrained.length} source(s) the audited epoch drew zero ` +
				`rows from: ${declaredButNotTrained.join(", ")}. Attributing them says the model learned from rows ` +
				`it never saw.`
		)
	}

	if (trainedButNotDeclared.length) {
		refusals.push(
			`${input.packageName} omits ${trainedButNotDeclared.length} source(s) the audited epoch emitted: ` +
				`${trainedButNotDeclared.join(", ")}. A consumer installing this package receives those rows' ` +
				`contribution without their attribution.`
		)
	}

	return refusals
}
