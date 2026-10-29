/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Assembles a `neural-weights-<locale>/` package directory from an int8 model, its tokenizer and a model card.
 *
 *   The directory holds `model.onnx`, `tokenizer.model`, `model-card.json`, `package.json` and `README.md`. The card
 *   lists the active label set's tags and BIO labels in emission order, the head's semantic-tag contract, the eval
 *   report it is given, and, for a model trained with an address-system head, the `address_systems` table the runtime
 *   reads to feed `locale_hint` and to read `address_system_logits`.
 *
 *   The JSON files are written the way Python's `json.dumps(indent=2)` writes them, so a card this module writes and
 *   one the Python packager wrote from the same inputs compare byte for byte: `ensure_ascii` escapes, and a value the
 *   card holds as a float keeps its `.0`.
 */

import { copyFileTo, makeDirectories, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { pyFixed } from "@mailwoman/core/numeric"
import { asPythonFloat, PythonFloat, pythonFloatRepr, pythonJSONDumps } from "@mailwoman/core/strings/python-json"
import {
	bioLabelsOf,
	DEFAULT_LABEL_SET,
	LABEL_SETS,
	STAGE1_COARSE_TAGS,
	STAGE2_FINE_TAGS,
	STAGE2_TAGS,
	STAGE3_FINE_TAGS,
	STAGE3_TAGS,
} from "@mailwoman/neural/labels"
import { labelSetContract } from "@mailwoman/neural/semantic-tags"
import type { AddressSystemRegistry } from "@mailwoman/neural/tools/address-system-registry"
import { join, type PathBuilderLike } from "path-ts"

/**
 * The label set a weights package ships.
 *
 * It is the default set, and the card writes its tags and BIO labels.
 */
export const ACTIVE_LABEL_SET = DEFAULT_LABEL_SET

/**
 * The active set's tags.
 */
export const ACTIVE_TAGS: readonly string[] = LABEL_SETS[ACTIVE_LABEL_SET]

/**
 * The active set's BIO labels, in the order the classifier head emits them.
 */
export const ACTIVE_BIO_LABELS: readonly string[] = bioLabelsOf(ACTIVE_TAGS)

/**
 * An eval report as the card stores it.
 *
 * It is a JSON object, and its float-valued numbers are {@linkcode PythonFloat}s.
 */
export type EvalReport = Record<string, unknown>

/**
 * The report written into a card when no golden set was evaluated.
 *
 * A reader can then tell an unmeasured bundle from one that scored zero.
 */
export function noEvalReport(): EvalReport {
	return {
		n_entries: 0,
		full_parse_exact_match: asPythonFloat(0),
		mean_token_confidence: asPythonFloat(0),
		per_component: {},
		calibration: [],
		note: "no golden_dir provided; eval skipped",
	}
}

/**
 * Parses an eval report, keeping each number written with a fraction or an exponent as a Python float.
 */
export function parseEvalReport(text: string): EvalReport {
	// oxlint-disable-next-line no-restricted-properties -- parseJSONStrict takes no reviver, and this one reads each number's source text.
	const report: unknown = JSON.parse(text, (_key, value: unknown, context?: { source?: string }) => {
		if (typeof value === "number" && context?.source != null && /[.eE]/u.test(context.source)) {
			return new PythonFloat(value)
		}

		return value
	})

	if (report == null || typeof report !== "object" || Array.isArray(report)) {
		throw new Error("the eval report is not a JSON object")
	}

	return report as EvalReport
}

/**
 * The number a report field holds, whether it was written as an integer or a float.
 */
function numeric(value: unknown, fallback: number): number {
	if (value instanceof PythonFloat) return value.value

	return typeof value === "number" ? value : fallback
}

/**
 * A report value as Python's `str` writes it into the README.
 */
function pythonStr(value: unknown): string {
	if (value instanceof PythonFloat) return pythonFloatRepr(value.value)

	return String(value)
}

function sameTags(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((tag, i) => tag === b[i])
}

/**
 * The card's `phase` string, read from the active tag list.
 */
export function phaseLabel(): string {
	if (sameTags(ACTIVE_TAGS, STAGE3_TAGS)) return "Stage 3 (street decomposition + unit/po_box/intersection)"

	if (sameTags(ACTIVE_TAGS, STAGE2_TAGS)) return "Stage 2 (coarse + venue/street/house_number)"

	if (sameTags(ACTIVE_TAGS, STAGE1_COARSE_TAGS)) return "Stage 1 (coarse)"

	return `Custom (${ACTIVE_TAGS.length} tags)`
}

/**
 * The card's `address_systems` table for a model trained with `count` address-system ids.
 *
 * `members` holds only ids below `count`.
 * A system registered after the model trained has no head output and no hint embedding,
 * so the runtime gives its countries `no_hint`.
 * Members are keyed `CC/script` and sorted.
 */
export function addressSystemCard(
	registry: AddressSystemRegistry,
	count: number
): { count: number; no_hint: number; members: Record<string, number> } {
	const members = registry.members
		.filter((member) => member.system < count)
		.map((member) => [`${member.country}/${member.script}`, member.system] as const)
		.toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))

	return { count, no_hint: count, members: Object.fromEntries(members) }
}

/**
 * What a model card records about the run and the bundle.
 */
export interface ModelCardInputs {
	locale: string
	corpusVersion: string
	tokenizerVersion: string
	trainingSteps: number
	evalReport: EvalReport
	notes: string
	trainingHardware: string
	trainingDurationSeconds: number
	/**
	 * The checkpoint directory, recorded as `base_relpath`.
	 */
	basePath: string
	packageVersion: string
	/**
	 * The trained model's `num_address_systems`.
	 * A nonzero count writes the `address_systems` table.
	 */
	addressSystemCount: number
	addressSystems: AddressSystemRegistry | null
	/**
	 * When the card was written.
	 */
	completedAt: Date
}

/**
 * A path as Python's `str(Path(p))` writes it.
 *
 * Empty and `.` segments are dropped, and the result has no trailing separator.
 */
export function pythonPathString(path: string): string {
	if (path === "") return "."
	const absolute = path.startsWith("/")
	const parts = path.split("/").filter((part) => part !== "" && part !== ".")
	const joined = parts.join("/")

	if (absolute) return "/" + joined

	return joined || "."
}

/**
 * `datetime.utcnow().isoformat() + "Z"`: microseconds only when nonzero.
 */
export function pythonUTCTimestamp(date: Date): string {
	const iso = date.toISOString()
	const [seconds, millis = "000"] = iso.slice(0, -1).split(".")

	return millis === "000" ? `${seconds}Z` : `${seconds}.${millis}000Z`
}

/**
 * The model card for one locale's package.
 */
export function buildModelCard(inputs: ModelCardInputs): Record<string, unknown> {
	const card: Record<string, unknown> = {
		name: `neural-weights-${inputs.locale}`,
		version: inputs.packageVersion,
		phase: phaseLabel(),
		license: "AGPL-3.0-only OR LicenseRef-Commercial",
		locale: inputs.locale,
		training: {
			corpus_version: inputs.corpusVersion,
			tokenizer_version: inputs.tokenizerVersion,
			steps: inputs.trainingSteps,
			hardware: inputs.trainingHardware,
			duration_seconds: asPythonFloat(inputs.trainingDurationSeconds),
			started_at: null,
			completed_at: pythonUTCTimestamp(inputs.completedAt),
		},
		components_supported: [...ACTIVE_TAGS],
		labels: [...ACTIVE_BIO_LABELS],
		semantic_tags: labelSetContract(ACTIVE_LABEL_SET),
		eval: inputs.evalReport,
		known_failure_modes: [
			"underperforms on Hawaiian addresses (sparse in training corpus)",
			"particle-honorific kryptonite (e.g. FR 'Saint-Just-Saint-Rambert') if not in synth set",
			"non-Latin scripts (CJK, Cyrillic) fall through to byte-fallback tokens; F1 unknown",
		],
		notes: inputs.notes,
		format: {
			model: "ONNX int8 dynamic",
			tokenizer: "SentencePiece unigram, byte_fallback=true, vocab_size=16000",
			max_sequence_length: 128,
			opset: 17,
		},
		files: {
			model: "model.onnx",
			tokenizer: "tokenizer.model",
			model_card: "model-card.json",
			crf_transitions: "crf-transitions.json",
		},
		base_relpath: inputs.basePath ? pythonPathString(inputs.basePath) : "",
	}

	if (inputs.addressSystemCount) {
		if (!inputs.addressSystems) {
			throw new Error(
				`the model has ${inputs.addressSystemCount} address systems and no address-system registry was read`
			)
		}

		card["address_systems"] = addressSystemCard(inputs.addressSystems, inputs.addressSystemCount)
	}

	return card
}

/**
 * The package's `package.json`.
 */
export function renderPackageJSON(locale: string, packageVersion: string): Record<string, unknown> {
	return {
		name: `@mailwoman/neural-weights-${locale}`,
		version: packageVersion,
		license: "AGPL-3.0-only OR LicenseRef-Commercial",
		description:
			`Mailwoman neural-classifier weights for locale '${locale}'. ` +
			"Data-only package — loaded by @mailwoman/neural at runtime.",
		files: ["model.onnx", "tokenizer.model", "model-card.json", "crf-transitions.json", "README.md"],
		publishConfig: { access: "public" },
		repository: { type: "git", url: "https://github.com/sister-software/mailwoman" },
		private: false,
	}
}

/**
 * Per-component F1 floors.
 * A tag outside the active set is skipped.
 */
const F1_TARGETS: ReadonlyArray<readonly [tag: string, target: number]> = [
	["country", 0.95],
	["region", 0.95],
	["locality", 0.95],
	["postcode", 0.95],
	["venue", 0.6],
	["street", 0.7],
	["house_number", 0.8],
]

/**
 * One line stating how the build measures against the per-tag F1 floors.
 */
export function targetStatusLine(report: EvalReport): string {
	const per = (report["per_component"] as Record<string, Record<string, unknown>> | null | undefined) ?? {}
	const active = new Set(ACTIVE_TAGS)
	const atTarget: string[] = []
	const below: Array<[string, number, number]> = []

	for (const [tag, target] of F1_TARGETS) {
		if (!active.has(tag) || !(tag in per)) continue
		const f1 = numeric(per[tag]?.["f1"], 0)

		if (f1 >= target) {
			atTarget.push(tag)
		} else {
			below.push([tag, f1, target])
		}
	}

	if (!below.length) return "**✓ Meets per-component F1 targets on every active component.**"

	const lines = ["**⚠ Below per-component F1 targets:**", ""]

	for (const [tag, f1, target] of below) {
		lines.push(`- \`${tag}\` F1 = **${pyFixed(f1, 4)}** (target ≥${pyFixed(target, 2)})`)
	}

	if (atTarget.length) {
		lines.push("")
		lines.push("At target: " + atTarget.map((t) => `\`${t}\``).join(", "))
	}

	return lines.join("\n")
}

/**
 * One line describing the active component set.
 */
export function componentsSupportedBlurb(): string {
	if (sameTags(ACTIVE_TAGS, STAGE3_TAGS)) {
		const fine = [...STAGE2_FINE_TAGS, ...STAGE3_FINE_TAGS].join(" / ")

		return (
			`Stage 3 ships coarse plus fine-grained ${fine} ` +
			"(street decomposed into prefix/suffix; unit, po_box, and intersection added). " +
			`Token classifier emits ${ACTIVE_BIO_LABELS.length} BIO labels.`
		)
	}

	if (sameTags(ACTIVE_TAGS, STAGE2_TAGS)) {
		return (
			`Stage 2 ships coarse (${STAGE1_COARSE_TAGS.join(" / ")}) plus fine-grained ` +
			`${STAGE2_FINE_TAGS.join(" / ")}. Token classifier emits 21 BIO labels.`
		)
	}

	if (sameTags(ACTIVE_TAGS, STAGE1_COARSE_TAGS)) {
		return (
			"Stage 1 ships coarse-only: " +
			STAGE1_COARSE_TAGS.join(" / ") +
			". Street- and venue-level components are explicit future phases."
		)
	}

	return `Components: ${ACTIVE_TAGS.join(" / ")}.`
}

/**
 * What the README states about the bundle.
 */
export interface ReadmeInputs {
	locale: string
	corpusVersion: string
	evalReport: EvalReport
	trainingSteps: number
	trainingHardware: string
	smoke: boolean
}

/**
 * The package README.
 */
export function renderReadme(inputs: ReadmeInputs): string {
	let head = `# @mailwoman/neural-weights-${inputs.locale}`

	if (inputs.smoke) {
		head += "\n\n> **⚠ SMOKE BUILD — NOT PRODUCTION WEIGHTS.** "
		head += "This package was assembled from a Phase 2 smoke training run to validate the "
		head += "pipeline end-to-end. The model is undertrained and does not meet the §6 success "
		head += "criteria. Replace with weights from a full GPU-host training run before publishing."
	}

	const report = inputs.evalReport

	const lines = [
		head,
		"",
		`${phaseLabel()} Mailwoman neural-classifier weights.`,
		"",
		`- locale: **${inputs.locale}**`,
		`- corpus: **${inputs.corpusVersion}**`,
		`- training steps: **${inputs.trainingSteps}**`,
		`- hardware: **${inputs.trainingHardware}**`,
		"",
		"## Per-component F1 targets",
		"",
		targetStatusLine(report),
		"",
		"## Eval (golden set)",
		"",
		`- entries: **${pythonStr(report["n_entries"] ?? 0)}**`,
		`- full-parse exact match: **${pyFixed(numeric(report["full_parse_exact_match"], 0), 4)}**`,
		`- mean token confidence: **${pyFixed(numeric(report["mean_token_confidence"], 0), 4)}**`,
		"",
		"## Components supported",
		"",
		componentsSupportedBlurb(),
		"",
		"## Files",
		"",
		"- `model.onnx` — int8-quantized ONNX model.",
		"- `tokenizer.model` — SentencePiece unigram tokenizer (matches the corpus version).",
		"- `model-card.json` — ModelCard with training + eval metadata.",
		"",
		"## Loader",
		"",
		"Loaded at runtime by `@mailwoman/neural`. This package contains no JS code.",
		"",
	]

	return lines.join("\n") + "\n"
}

/**
 * A JSON document as `json.dumps(value, indent=2) + "\n"` writes it.
 */
export function pythonJSONFileText(value: unknown): string {
	return pythonJSONDumps(value, { indent: 2 }) + "\n"
}

/**
 * The files of one package directory.
 */
export interface PackageFiles {
	int8ModelPath: PathBuilderLike
	tokenizerModelPath: PathBuilderLike
	modelCard: Record<string, unknown>
	packageJSON: Record<string, unknown>
	readme: string
}

/**
 * Writes one package directory, replacing the files it holds.
 */
export async function writeWeightsPackage(packageDirectory: PathBuilderLike, files: PackageFiles): Promise<void> {
	await makeDirectories(packageDirectory)
	await copyFileTo(files.int8ModelPath, join(packageDirectory, "model.onnx"))
	await copyFileTo(files.tokenizerModelPath, join(packageDirectory, "tokenizer.model"))
	await writeLocalTextFile(pythonJSONFileText(files.modelCard), packageDirectory, "model-card.json")
	await writeLocalTextFile(pythonJSONFileText(files.packageJSON), packageDirectory, "package.json")
	await writeLocalTextFile(files.readme, packageDirectory, "README.md")
}
