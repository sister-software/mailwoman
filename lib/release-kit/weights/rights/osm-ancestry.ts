/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Whether a weights package's model descends from OpenStreetMap data, and whether the package
 *   identifies that ancestry where a reader looks.
 *
 *   A package has OpenStreetMap ancestry when its own effective training manifest records a source
 *   derived from OpenStreetMap that reached the trainer, or when a package its `mailwoman.baseWeights`
 *   chain reaches does. An overlay that sampled no OpenStreetMap row still decodes through its base's
 *   graph, so it inherits that graph's ancestry. A package with ancestry must include the
 *   OpenStreetMap entry in its own model card's attribution and the OpenStreetMap statement in its
 *   README, because a consumer who installs that package reads those two files and none of its base's.
 *
 *   A card cannot record the checkpoint a model was initialized from. `model_lineage` is prose, and
 *   the training manifests are keyed by corpus rather than by checkpoint, so ancestry through a
 *   fine-tune is unread here. {@link INITIALIZATION_ANCESTRY_UNREAD} states that gap in the audit.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { pathExists } from "@mailwoman/core/fs/readers/stat"
import type { EffectiveSourceRecord, EffectiveTrainingManifest } from "@mailwoman/corpus/source-register"
import { type PathBuilderLike, resolvePath } from "path-ts"

import type { AttributionRecord, WeightsRightsRecord } from "#release-kit/weights/rights/record"

/**
 * The README statement required when the package has OpenStreetMap ancestry, matched as a substring.
 */
const README_NOTICE = "© OpenStreetMap contributors"

/**
 * Why ancestry through fine-tuning is not part of this check, stated in the audit's unresolved list.
 */
export const INITIALIZATION_ANCESTRY_UNREAD =
	"No model card records the checkpoint its model was initialized from as a field: `model_lineage` is prose, and " +
	"the training manifests are keyed by corpus version rather than by checkpoint. OpenStreetMap ancestry is read " +
	"from each card's own effective training manifest and from the `mailwoman.baseWeights` chain, so a model " +
	"fine-tuned from an OpenStreetMap-trained checkpoint on an OpenStreetMap-free corpus is not detected."

/**
 * Whether one effective-manifest source is derived from OpenStreetMap and reached the trainer.
 *
 * An `osm` or `osm-<cc>` source id is an extract, and a license naming ODbL
 * or OpenStreetMap covers the registers rendered from OpenStreetMap tuples
 * and the synthetic rows that splice OpenStreetMap names.
 * Their ids do not identify that source.
 */
function isOpenStreetMapDerived(source: EffectiveSourceRecord): boolean {
	if (source.emittedRows <= 0) return false

	return /^osm(?:-|$)/u.test(source.source) || /\bODbL\b|OpenStreetMap/iu.test(source.license)
}

/**
 * The OpenStreetMap-derived sources an effective training manifest records as reaching the trainer, sorted.
 */
function openStreetMapTrainingSources(manifest: EffectiveTrainingManifest | null): string[] {
	if (!manifest) return []

	return manifest.sources
		.filter(isOpenStreetMapDerived)
		.map((source) => source.source)
		.toSorted()
}

/**
 * Whether a card's attribution entries include the OpenStreetMap entry: one naming OpenStreetMap and ODbL.
 */
export function declaresOpenStreetMapAttribution(attribution: readonly AttributionRecord[]): boolean {
	return attribution.some((entry) => /OpenStreetMap/u.test(entry.text) && /\bODbL\b/u.test(entry.text))
}

/**
 * One package's OpenStreetMap ancestry and what it declares about it.
 */
export interface OpenStreetMapAncestry {
	package: string
	/**
	 * OpenStreetMap-derived sources the package's own effective training manifest
	 * records as reaching the trainer.
	 */
	ownSources: string[]
	/**
	 * The nearest package in the `mailwoman.baseWeights` chain with OpenStreetMap ancestry, or `null`.
	 */
	inheritedFrom: string | null
	/**
	 * Why that base counts: its OpenStreetMap training sources, or its own card's OpenStreetMap entry.
	 */
	inheritedEvidence: string | null
	declaresAttribution: boolean
	/**
	 * Whether the README states the OpenStreetMap credit, or `null` when the package has no README.
	 */
	readmeCarriesNotice: boolean | null
}

/**
 * The base's ancestry as its own record states it, or `null` when the record shows none.
 */
function baseEvidence(base: WeightsRightsRecord): string | null {
	const sources = openStreetMapTrainingSources(base.effectiveTraining)

	if (sources.length) return `its effective training manifest records ${sources.join(", ")}`

	if (declaresOpenStreetMapAttribution(base.attribution)) return "its model card attributes OpenStreetMap"

	return null
}

/**
 * Whether the README states the credit, or `null` when the workspace has none.
 *
 * A README present and unreadable throws rather than reading as absent.
 */
async function readmeCarriesNotice(repoRoot: PathBuilderLike, workspace: string): Promise<boolean | null> {
	const path = resolvePath(repoRoot, workspace, "README.md")

	if (!(await pathExists(path))) return null

	return (await readLocalTextFile(path)).includes(README_NOTICE)
}

/**
 * Each package's OpenStreetMap ancestry, read from its own effective manifest and its base chain.
 *
 * `records` must be the whole set `readWeightsRightsRecords` returned,
 * so each base in an inherited chain resolves to its record.
 */
export async function readOpenStreetMapAncestry(
	repoRoot: PathBuilderLike,
	records: readonly WeightsRightsRecord[]
): Promise<OpenStreetMapAncestry[]> {
	const byName = new Map(records.map((record) => [record.packageName, record]))
	const rows: OpenStreetMapAncestry[] = []

	for (const record of records) {
		let inheritedFrom: string | null = null
		let inheritedEvidence: string | null = null

		// The chain starts with the package itself.
		for (const name of record.inherited?.chain.slice(1) ?? []) {
			const base = byName.get(name)
			const evidence = base ? baseEvidence(base) : null

			if (evidence) {
				inheritedFrom = name
				inheritedEvidence = evidence

				break
			}
		}

		rows.push({
			package: record.packageName,
			ownSources: openStreetMapTrainingSources(record.effectiveTraining),
			inheritedFrom,
			inheritedEvidence,
			declaresAttribution: declaresOpenStreetMapAttribution(record.attribution),
			readmeCarriesNotice: await readmeCarriesNotice(repoRoot, record.workspace),
		})
	}

	return rows
}

/**
 * Why each package with OpenStreetMap ancestry omits the required notice, one sentence per notice.
 *
 * Empty when every package with ancestry includes both notices, or when no package has ancestry.
 */
export function openStreetMapAttributionRefusals(rows: readonly OpenStreetMapAncestry[]): string[] {
	const refusals: string[] = []

	for (const row of rows) {
		const because = row.ownSources.length
			? `its effective training manifest records ${row.ownSources.join(", ")}`
			: row.inheritedFrom
				? `it decodes through ${row.inheritedFrom}, and ${row.inheritedEvidence}`
				: null

		if (!because) continue

		if (!row.declaresAttribution) {
			refusals.push(
				`${row.package}: ${because}, and its model card's attribution has no OpenStreetMap entry naming ODbL.`
			)
		}

		if (row.readmeCarriesNotice !== true) {
			refusals.push(
				`${row.package}: ${because}, and its README ${row.readmeCarriesNotice === null ? "is missing" : `does not state "${README_NOTICE}"`}.`
			)
		}
	}

	return refusals
}
