/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   What one weights package ships, which rights govern it, and which of those questions the repository cannot answer
 *   — read from the package manifest and the model card, with every gap recorded as a gap.
 *
 *   The record separates two things that a single `data_attribution` list runs together. A license obligation follows
 *   from the terms a distributor grants: this package is `AGPL-3.0-only OR LicenseRef-Commercial`, and that expression
 *   states what a consumer may do with the artifacts. A provenance obligation follows from where an artifact's inputs
 *   came from: attribution and share-alike conditions attach to the source and survive redistribution, whichever branch
 *   of our own license a consumer takes. The two are rendered into separate files for that reason.
 *
 *   Three readings here would each be wrong in the same direction, so none of them is made. A package whose card
 *   records no training attribution is recorded as recording none, never as having none. A declared artifact with no
 *   digest is recorded `unrecorded`, never as verified. And an overlay does not inherit its base's attribution list as
 *   though it were its own: the base's record is named, and the overlay's own artifacts keep whatever attribution the
 *   repository actually holds for them.
 *
 *   The last part is what a per-package record adds over one list in one card. `pair-index-gb.bin` ships in
 *   `@mailwoman/neural-weights-en-gb`, and the entry attributing it to HM Land Registry Price Paid Data under OGL v3.0
 *   sits in `@mailwoman/neural-weights-en-us`'s card. A consumer who installs the overlay receives the artifact and no
 *   attribution. {@link readWeightsRightsRecords} finds that class by looking for each package's artifact filenames in
 *   every other package's attribution text.
 */

import { pathExists, readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { readPackageJSON } from "@mailwoman/core/module/resolve-from"
import { resolvePath } from "path-ts"

import { literalFilesEntries } from "#pack/verify-tarball"

/**
 * What a package's `version` field in `model-card.json` denotes.
 *
 * A graph package's card version names the trained model: `en-us` at 9.1.0 is the suffix-boundary model, and `mwops
 * release verify-metadata` keys the ledger and documentation checks off it rather than off the npm version. An
 * overlay's card version names that overlay's own artifacts, and the graph its rows decode through is whatever
 * `mailwoman.baseWeights` resolves to.
 *
 * Neither number is the npm version, which moves in lockstep across every workspace on every release. The two series
 * are described in `docs/records/site-2026-08/releases.mdx`.
 */
export const VersionSeries = {
	Model: "model",
	Overlay: "overlay",
} as const

export type VersionSeries = (typeof VersionSeries)[keyof typeof VersionSeries]

/**
 * What an artifact is, which decides whose lineage it carries.
 *
 * A package ships files with unrelated provenance under one `files` array. `model.onnx` carries the corpus a training
 * run read. `tokenizer.model` carries the text a tokenizer was fitted on, which is a different and usually smaller set.
 * A pair index and a postcode binary are each built from one named register. A lexicon is curated. Reporting one
 * attribution list against all of them attributes the corpus to files no corpus touched, and leaves the files that do
 * have a distinct source unattributed.
 *
 * Derived from the filename, because that is what the manifest gives and the naming is consistent across the twelve
 * published packages. An unrecognized name reads `other` rather than being guessed into a role.
 */
export const ArtifactRole = {
	ModelGraph: "model-graph",
	Tokenizer: "tokenizer",
	CharacterVocabulary: "character-vocabulary",
	Lexicon: "lexicon",
	PlacetypePairIndex: "placetype-pair-index",
	PostcodeBinary: "postcode-binary",
	Gazetteer: "gazetteer-fst",
	Calibration: "calibration",
	Other: "other",
} as const

export type ArtifactRole = (typeof ArtifactRole)[keyof typeof ArtifactRole]

/**
 * The role a declared filename carries.
 */
export function roleForArtifact(path: string): ArtifactRole {
	const exact: Readonly<Record<string, ArtifactRole>> = {
		"model.onnx": ArtifactRole.ModelGraph,
		"tokenizer.model": ArtifactRole.Tokenizer,
		"char-vocab.json": ArtifactRole.CharacterVocabulary,
	}

	const byPrefix: ReadonlyArray<readonly [string, ArtifactRole]> = [
		["pair-index-", ArtifactRole.PlacetypePairIndex],
		["postcode-", ArtifactRole.PostcodeBinary],
		["fst-", ArtifactRole.Gazetteer],
		["calibration", ArtifactRole.Calibration],
	]

	const named = exact[path]

	if (named) return named

	for (const [prefix, role] of byPrefix) {
		if (path.startsWith(prefix)) return role
	}

	return path.includes("-lexicon-v") ? ArtifactRole.Lexicon : ArtifactRole.Other
}

/**
 * A digest the card records for an artifact, or the reason there is none.
 */
export interface ArtifactRecord {
	path: string
	role: ArtifactRole
	md5: string | null
	/**
	 * `recorded` when the card's `files_md5` names this artifact. `unrecorded` when it does not. An unrecorded digest is
	 * not a verified one, and a reader that treated `md5: null` as "nothing to check" would read the second as the
	 * first.
	 */
	digest: "recorded" | "unrecorded"
}

/**
 * How a source contributed, as its own entry states it.
 *
 * A single attribution list runs three different contributions together. Two of `en-us`'s ten entries describe a
 * coordinate evaluation set and no training rows at all, and reading them as training attribution says the model
 * learned from data it never saw. Two more describe tokenizer-splice text, which is a different and far smaller set
 * than the training corpus.
 *
 * An entry may carry more than one. `OpenAddresses CZ … tokenizer-splice training text + the oa-cz coord eval sets`
 * carries two, and flattening it to either one loses a fact the entry states.
 */
export const SourceUse = {
	Training: "training",
	Tokenizer: "tokenizer",
	Evaluation: "evaluation",
	/**
	 * The entry says nothing about how the source was used. The pointer to `THIRD_PARTY_NOTICES.md` is the case.
	 */
	Unstated: "unstated",
} as const

export type SourceUse = (typeof SourceUse)[keyof typeof SourceUse]

/**
 * The uses one attribution entry states, read from its own words.
 *
 * A reading of prose rather than of a field, so it reports what the entry says and the entry travels verbatim beside
 * it. `unstated` is returned when nothing matches, never `training`: defaulting to training would turn every entry
 * whose wording this does not recognize into a claim about what the model learned from.
 */
export function usesStatedIn(entry: string): SourceUse[] {
	const uses: SourceUse[] = []
	const text = entry.toLowerCase()

	if (/tokenizer[- ](?:splice|training)/u.test(text)) {
		uses.push(SourceUse.Tokenizer)
	}

	if (/\beval\b|\beval set|evaluation|validation\b/u.test(text)) {
		uses.push(SourceUse.Evaluation)
	}

	if (/training extract|training rows|\btrained on\b|training corpus/u.test(text)) {
		uses.push(SourceUse.Training)
	}

	return uses.length ? uses : [SourceUse.Unstated]
}

/**
 * One attribution entry as the card states it, plus whether it names a license.
 */
export interface AttributionRecord {
	/**
	 * The entry verbatim. Reproduced rather than summarized: the entry is the statement the repository has made, and a
	 * paraphrase of a rights statement is a different statement.
	 */
	text: string
	/**
	 * The license the entry names, when the entry names one in the parenthetical the cards use. `null` when it names
	 * none, which is a gap rather than a permissive reading.
	 */
	licenseNamed: string | null
	/**
	 * What the entry says the source was used for. `["unstated"]` when it says nothing, never `["training"]`.
	 */
	uses: SourceUse[]
}

/**
 * What an overlay inherits from the package whose model graph it decodes through.
 *
 * The attribution is the base's, restated here so a consumer who installed the overlay alone can read it, and labeled
 * as the base's so nobody reads it as a claim about this package's own artifacts. `en-au` inherits `en-us`'s ten
 * entries and contributed none of them: no AusTender row trained that encoder, and an inherited list presented as the
 * overlay's own would say it did.
 */
export interface InheritedLineage {
	package: string
	packageVersion: string
	modelCardVersion: string | null
	attribution: AttributionRecord[]
	/**
	 * The chain from this package to the graph package, longest first, when a base itself declares a base. Cycles and an
	 * unresolvable base are reported rather than followed.
	 */
	chain: string[]
	unresolved: string | null
}

/**
 * An artifact this package ships whose attribution another package's card carries.
 */
export interface ForeignAttribution {
	artifact: string
	recordedIn: string
	text: string
}

export interface WeightsRightsRecord {
	workspace: string
	packageName: string
	packageVersion: string
	/**
	 * The SPDX expression the manifest declares. The `package-license` repository check holds it equal to the root's.
	 */
	license: string
	/**
	 * The card's own version, or `null` when the package ships no card. `base-latn` is the one such package.
	 */
	modelCardVersion: string | null
	versionSeries: VersionSeries
	/**
	 * The package whose model graph this one decodes through, or `null` for a graph package.
	 */
	baseWeights: string | null
	artifacts: ArtifactRecord[]
	/**
	 * The card's attribution entries, from whichever of the two spellings it uses. An empty array means the card records
	 * none under either.
	 */
	attribution: AttributionRecord[]
	foreignAttribution: ForeignAttribution[]
	/**
	 * The lineage this package inherits by decoding through another package's model graph, or `null` for a graph package.
	 *
	 * An overlay ships its own artifacts and no model graph, so what its rows were trained on is a fact about the base.
	 * Naming the base and stopping leaves a consumer who installed the overlay alone unable to see any of it, which is
	 * the state every overlay's record was in: `base_weights` filled, `training_attribution` empty.
	 */
	inherited: InheritedLineage | null
	/**
	 * The corpus the card names, when it names one. Not evidence of which records reached the model: the corpus on the
	 * training volume moves, and no frozen per-release manifest exists to compare it against.
	 */
	corpusVersion: string | null
	tokenizerVersion: string | null
}

interface ModelCard {
	version?: unknown
	files_md5?: unknown
	/**
	 * The spelling `cjk` uses.
	 */
	attribution?: unknown
	training?: {
		/**
		 * The spelling `en-us` uses.
		 */
		data_attribution?: unknown
		corpus_version?: unknown
		tokenizer_version?: unknown
	}
}

/**
 * The attribution entries a card holds, under either spelling the two graph packages use.
 *
 * `en-us` records them at `training.data_attribution` and `cjk` at a top-level `attribution`. Reading one spelling
 * reports the other package as recording nothing, which is the reading this whole record exists to refuse: `cjk`
 * carries six entries, each naming its license, including the Taiwanese Open Government Data License that voids without
 * its 顯名聲明 and the fifteen civil affairs bureaux that license names.
 *
 * Both are read rather than one being migrated to the other, because a model card is a published artifact: the twelve
 * on npm carry the spelling they were published with, and a reader of this repository has to match them.
 */
function attributionEntries(card: ModelCard | null): string[] {
	const candidates = [card?.training?.data_attribution, card?.attribution]

	for (const candidate of candidates) {
		if (!Array.isArray(candidate)) continue

		const entries = candidate.filter((entry): entry is string => typeof entry === "string")

		if (entries.length) return entries
	}

	return []
}

/**
 * The license a card's attribution entry names, from the parenthetical the entries use — `LINZ-derived OpenAddresses NZ
 * (CC-BY 4.0): …` yields `CC-BY 4.0`. `null` when no parenthetical in the entry holds one, which includes the OA PL
 * entry whose parenthetical reads `public, BDOT-derived`.
 *
 * A `null` here reports what this reader found rather than what the entry grants. Two of `cjk`'s entries state their
 * terms as 利用規約 and 이용허락범위 제한 없음, outside any parenthetical, so they read `null` while naming terms. The entry text
 * travels verbatim beside this field for that reason.
 */
export function licenseNamedIn(entry: string): string | null {
	// Every parenthetical rather than the first. An entry commonly opens with the dataset's own name — `Korean
	// road-name address data (주소DB): 행정안전부 …, 공공누리 제1유형 (KOGL Type 1)` — and reading only the first reports an entry
	// that names KOGL Type 1 as naming no license at all.
	for (const match of entry.matchAll(/\(([^()]{1,120})\)/gu)) {
		const inner = match[1]!.trim()

		// A license identifier carries a version number, or a family name this repository recognizes, or the word
		// `license` in one of its spellings. `public, BDOT-derived` carries none of the three and describes access
		// rather than a grant.
		const namesLicense =
			/\d/u.test(inner) ||
			/\b(?:CC0|CC-BY|CC|ODbL|PDDL|OGL|OGDL|KOGL|CDLA|Etalab|MIT|Apache|Licence|License|Lizenz)\b/iu.test(inner)

		if (namesLicense) return inner
	}

	return null
}

/**
 * Files a weights package declares that document it rather than carry data.
 *
 * The same distinction `data-provenance` draws over a `data/` directory, for the same reason: a digest over a README
 * states nothing about an input's provenance, and listing one as an artifact with no digest reports a gap that is not
 * one. `model-card.json` joins them because it is the record the rest of this document is read from.
 */
const DOCUMENTATION_FILES: ReadonlySet<string> = new Set([
	"README.md",
	"LICENSE.md",
	"LICENSE",
	"PROVENANCE.json",
	"model-card.json",
])

function stringOrNull(value: unknown): string | null {
	return typeof value === "string" && value.length ? value : null
}

/**
 * Read one weights workspace's record. Throws when the manifest is unreadable rather than returning an empty record: a
 * rights record nobody can read must not resolve to a package that ships nothing and owes nothing.
 */
export async function readWeightsRightsRecord(repoRoot: string, workspace: string): Promise<WeightsRightsRecord> {
	const manifest = await readPackageJSON(String(resolvePath(repoRoot, workspace, "package.json")))
	const cardPath = resolvePath(repoRoot, workspace, "model-card.json")
	const card = (await pathExists(cardPath)) ? await readLocalJSONFile<ModelCard>(cardPath) : null

	const packageName = stringOrNull(manifest.name)
	const packageVersion = stringOrNull(manifest.version)
	const license = stringOrNull(manifest.license)

	if (!packageName || !packageVersion || !license) {
		throw new Error(`${workspace}/package.json is missing one of "name", "version" or "license"`)
	}

	const baseWeights = stringOrNull(manifest.mailwoman?.baseWeights)
	const digests = (card?.files_md5 ?? {}) as Record<string, unknown>

	const artifacts: ArtifactRecord[] = literalFilesEntries(manifest.files)
		.filter((path) => !DOCUMENTATION_FILES.has(path))
		.map((path) => {
			const md5 = stringOrNull(digests[path])

			return { path, role: roleForArtifact(path), md5, digest: md5 ? "recorded" : "unrecorded" }
		})

	const attribution = attributionEntries(card)

	return {
		workspace,
		packageName,
		packageVersion,
		license,
		modelCardVersion: stringOrNull(card?.version),
		versionSeries: baseWeights ? VersionSeries.Overlay : VersionSeries.Model,
		baseWeights,
		artifacts,
		attribution: attribution.map((text) => ({
			text,
			licenseNamed: licenseNamedIn(text),
			uses: usesStatedIn(text),
		})),
		foreignAttribution: [],
		// Both filled by `readWeightsRightsRecords`: each is a question about the set rather than about one package.
		inherited: null,
		corpusVersion: stringOrNull(card?.training?.corpus_version),
		tokenizerVersion: stringOrNull(card?.training?.tokenizer_version),
	}
}

/**
 * Every weights workspace's record, with {@link WeightsRightsRecord.foreignAttribution} filled in.
 *
 * The cross-package pass runs here rather than in the single-workspace reader because it is a question about the set:
 * an artifact's attribution is foreign only relative to the other packages that could have carried it, and reading one
 * package cannot establish that.
 */
export async function readWeightsRightsRecords(
	repoRoot: string,
	workspaces: readonly string[]
): Promise<WeightsRightsRecord[]> {
	const records: WeightsRightsRecord[] = []

	for (const workspace of workspaces) {
		records.push(await readWeightsRightsRecord(repoRoot, workspace))
	}

	for (const record of records) {
		for (const artifact of record.artifacts) {
			for (const other of records) {
				if (other.workspace === record.workspace) continue

				for (const entry of other.attribution) {
					if (!entry.text.includes(artifact.path)) continue

					record.foreignAttribution.push({
						artifact: artifact.path,
						recordedIn: other.packageName,
						text: entry.text,
					})
				}
			}
		}
	}

	const byName = new Map(records.map((record) => [record.packageName, record]))

	for (const record of records) {
		record.inherited = resolveInherited(record, byName)
	}

	return records
}

/**
 * Walk from an overlay to the package that owns the model graph, and carry that package's attribution back.
 *
 * Follows `mailwoman.baseWeights` rather than assuming one hop, since a base may itself declare one. A cycle and a base
 * outside the set both stop the walk and are reported in `unresolved`, because a lineage that cannot be resolved is a
 * different answer from a lineage that is empty — and this record exists to keep those apart.
 */
function resolveInherited(
	record: WeightsRightsRecord,
	byName: ReadonlyMap<string, WeightsRightsRecord>
): InheritedLineage | null {
	if (!record.baseWeights) return null

	const chain: string[] = [record.packageName]
	const seen = new Set<string>([record.packageName])
	let current = record.baseWeights

	for (;;) {
		if (seen.has(current)) {
			return {
				package: current,
				packageVersion: "",
				modelCardVersion: null,
				attribution: [],
				chain: [...chain, current],
				unresolved: `the base chain returns to ${current}, so no package in it owns a model graph`,
			}
		}

		const base = byName.get(current)

		if (!base) {
			return {
				package: current,
				packageVersion: "",
				modelCardVersion: null,
				attribution: [],
				chain: [...chain, current],
				unresolved: `${current} is not among the packages read, so its lineage could not be resolved here`,
			}
		}

		seen.add(current)
		chain.push(current)

		if (!base.baseWeights) {
			return {
				package: base.packageName,
				packageVersion: base.packageVersion,
				modelCardVersion: base.modelCardVersion,
				attribution: base.attribution,
				chain,
				unresolved: null,
			}
		}

		current = base.baseWeights
	}
}
