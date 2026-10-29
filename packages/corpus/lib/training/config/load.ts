/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Reads a training run config into the schema's defaults, checks the corpus sources it admits, and writes the
 *   versioned resolved config the Rust trainer and sampler read.
 *
 *   The merge and coercion reproduce `corpus-python/src/mailwoman_train/config/load.py`. A known key replaces the
 *   default and an unknown key is refused with its dotted path and file. A numeric string converts only under a
 *   field annotated exactly `int` or `float`. The three held-out floor lists are validated with the Python
 *   loader's messages. The resolver then refuses three things the Python loader admits: a non-string
 *   `country_weights` key, which `DataConfig.__post_init__` refuses only at construction and so never sees a
 *   loaded YAML; a value whose type its field does not declare; and a mapping key that a JSON object cannot keep
 *   in its YAML position.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { sha256File } from "@mailwoman/core/hash"
import { resolvePath, type PathBuilderLike } from "path-ts"

import {
	createSourceRightsAdmission,
	readCorpusSourceInputs,
	SourceRightsError,
	TRAINING_OPERATIONS,
	type CorpusSourceInputs,
	type SourceRightsRecord,
} from "#source-register/corpus-inputs"
import { readAddressSourceRegister } from "#source-register/register"
import type { AddressSourceRegister } from "#source-register/types"
import {
	parsePythonYAML,
	pythonRepr,
	pythonTypeName,
	type PythonMapping,
	type PythonValue,
} from "#training/config/python-yaml"
import {
	CONFIG_SECTION,
	CORPUS_RECEIPT_SECTION,
	LABEL_SUPPORT_SECTION,
	RESOLVED_TRAINING_CONFIG_VERSION,
	TrainingConfigSchema,
	VALIDATION_COVERAGE_SECTION,
	type ConfigSectionSpec,
	type TrainingConfig,
} from "#training/config/schema"

/**
 * The Python exception class a refusal corresponds to, so a comparison with
 * the Python loader reads one field.
 */
export const ConfigErrorKind = {
	Key: "KeyError",
	Type: "TypeError",
	Value: "ValueError",
} as const

export type ConfigErrorKind = (typeof ConfigErrorKind)[keyof typeof ConfigErrorKind]

/**
 * A config the loader refuses, with the message the Python loader raises for it.
 */
export class TrainingConfigError extends Error {
	readonly kind: ConfigErrorKind

	constructor(kind: ConfigErrorKind, message: string) {
		super(message)
		this.name = "TrainingConfigError"
		this.kind = kind
	}
}

/**
 * One dataclass instance as the loader fills it: each declared field's current value.
 */
export interface ConfigInstance {
	spec: ConfigSectionSpec
	values: Map<string, ConfigValue>
}

export type ConfigValue = PythonValue | ConfigInstance

function isInstance(value: ConfigValue | undefined): value is ConfigInstance {
	return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Map)
}

/**
 * A dataclass instance holding every default, as `Config()` builds it.
 */
export function defaultConfigInstance(spec: ConfigSectionSpec = CONFIG_SECTION): ConfigInstance {
	const values = new Map<string, ConfigValue>()

	for (const [name, declared] of Object.entries(spec.fields)) {
		values.set(name, declared.section ? defaultConfigInstance(declared.section) : declared.default())
	}

	return { spec, values }
}

/**
 * Python's `str()` of a mapping key, as the dotted path in a message spells it.
 */
function pythonStr(value: PythonValue): string {
	if (typeof value === "string") return value

	return pythonRepr(value)
}

/**
 * Python's truth value, which `yaml.safe_load(fh) or {}` reads.
 */
function pythonTruthy(value: PythonValue): boolean {
	if (value === null || value === false || value === 0 || value === 0n || value === "") return false

	if (Array.isArray(value)) return value.length > 0

	if (value instanceof Map) return value.size > 0

	return true
}

const DECIMAL_DIGITS = String.raw`[0-9](?:_?[0-9])*`

const PYTHON_FLOAT_LITERAL = new RegExp(
	String.raw`^[-+]?(?:(?:${DECIMAL_DIGITS}(?:\.(?:${DECIMAL_DIGITS})?)?|\.${DECIMAL_DIGITS})(?:[eE][-+]?${DECIMAL_DIGITS})?|inf|infinity|nan)$`,
	"i"
)

const PYTHON_INT_LITERAL = new RegExp(String.raw`^[-+]?${DECIMAL_DIGITS}$`)

/**
 * Python's `float(text)`, or `undefined` where it raises `ValueError`.
 */
function pythonFloatOf(text: string): number | undefined {
	const trimmed = text.trim()

	if (!PYTHON_FLOAT_LITERAL.test(trimmed)) return undefined

	const lowered = trimmed.toLowerCase().replaceAll("_", "")
	const sign = lowered.startsWith("-") ? -1 : 1
	const body = lowered.replace(/^[-+]/, "")

	if (body === "nan") return Number.NaN

	if (body === "inf" || body === "infinity") return sign * Number.POSITIVE_INFINITY

	return sign * Number(body)
}

/**
 * Python's `int(text)`, or `undefined` where it raises `ValueError`.
 */
function pythonIntOf(text: string): bigint | undefined {
	const trimmed = text.trim()

	if (!PYTHON_INT_LITERAL.test(trimmed)) return undefined

	return BigInt(trimmed.replaceAll("_", "").replace(/^\+/, ""))
}

interface MergeContext {
	strict: boolean
	path: string
	source: string
}

/**
 * Merges `src` into `dst` key by key, as `merge_into` does.
 *
 * A key the dataclass does not declare is refused under `strict` and skipped otherwise.
 * A mapping under a nested section merges into it, and every other value replaces
 * the field through {@linkcode coerceField}.
 *
 * @throws {TrainingConfigError} naming the dotted key and the config source.
 */
export function mergeIntoConfig(dst: ConfigInstance, src: PythonMapping, context: Partial<MergeContext> = {}): void {
	const strict = context.strict ?? true
	const path = context.path ?? ""
	const source = context.source ?? "<mapping>"

	for (const [key, value] of src) {
		const dotted = path ? `${path}.${pythonStr(key)}` : pythonStr(key)

		if (typeof key !== "string") {
			throw new TrainingConfigError(ConfigErrorKind.Type, `attribute name must be string, not '${pythonTypeName(key)}'`)
		}

		if (!Object.hasOwn(dst.spec.fields, key)) {
			if (strict) {
				throw new TrainingConfigError(
					ConfigErrorKind.Key,
					`unknown config key ${pythonRepr(dotted)} in ${source}: ` +
						`${dst.spec.className} has no field ${pythonRepr(key)}. ` +
						"Either the key is a typo, or the config predates/postdates this " +
						"code — sync the volume-side source before launching (#1248)."
				)
			}

			continue
		}

		const current = dst.values.get(key)

		if (isInstance(current) && value instanceof Map) {
			mergeIntoConfig(current, value, { strict, path: dotted, source })
		} else {
			dst.values.set(key, coerceField(dst, key, value, { strict, path: dotted, source }))
		}
	}
}

/**
 * Merges each mapping of a list field into a fresh instance of `element`.
 */
function mergeElements(
	value: PythonValue,
	element: ConfigSectionSpec,
	label: string,
	context: MergeContext
): ConfigInstance[] {
	if (!Array.isArray(value)) throw new TrainingConfigError(ConfigErrorKind.Type, `${label} must be a list`)

	return value.map((item, index) => {
		if (!(item instanceof Map)) {
			throw new TrainingConfigError(ConfigErrorKind.Type, `${label}[${index}] must be a mapping`)
		}

		const instance = defaultConfigInstance(element)

		mergeIntoConfig(instance, item, { ...context, path: `${context.path}[${index}]` })

		return instance
	})
}

function field(instance: ConfigInstance, name: string): PythonValue {
	return instance.values.get(name) as PythonValue
}

/**
 * Whether a list holds a repeated entry, comparing each entry's key as Python compares tuples of strings.
 */
function hasRepeat(keys: readonly string[]): boolean {
	return new Set(keys).size !== keys.length
}

function bareTagProblem(tag: PythonValue): boolean {
	return typeof tag !== "string" || !tag || tag === "O" || tag.includes("-")
}

function validateCorpusReceipts(receipts: readonly ConfigInstance[]): void {
	for (const receipt of receipts) {
		const name = field(receipt, "name")
		const named = pythonRepr(name)
		const sequence = field(receipt, "component_sequence")

		if (typeof name !== "string") {
			throw new TrainingConfigError(ConfigErrorKind.Type, "corpus receipt name must be a string")
		}

		if (typeof field(receipt, "min_draws") !== "bigint") {
			throw new TrainingConfigError(ConfigErrorKind.Type, `receipt ${named} min_draws must be an integer`)
		}

		for (const optional of ["source", "country"]) {
			const value = field(receipt, optional)

			if (value !== null && typeof value !== "string") {
				throw new TrainingConfigError(ConfigErrorKind.Type, `receipt ${named} ${optional} must be a string or null`)
			}
		}

		if (!Array.isArray(sequence) || !sequence.every((tag) => typeof tag === "string")) {
			throw new TrainingConfigError(
				ConfigErrorKind.Type,
				`receipt ${named} component_sequence must be a list of strings`
			)
		}
	}

	const names = receipts.map((receipt) => field(receipt, "name") as string)

	if (names.some((name) => !name.trim())) {
		throw new TrainingConfigError(
			ConfigErrorKind.Value,
			"every data.required_corpus_receipts entry needs a non-empty name"
		)
	}

	if (hasRepeat(names)) {
		throw new TrainingConfigError(ConfigErrorKind.Value, "data.required_corpus_receipts names must be unique")
	}

	for (const receipt of receipts) {
		const named = pythonRepr(field(receipt, "name"))

		if ((field(receipt, "min_draws") as bigint) <= 0n) {
			throw new TrainingConfigError(ConfigErrorKind.Value, `receipt ${named} min_draws must be positive`)
		}

		const invalid = (field(receipt, "component_sequence") as string[]).filter(bareTagProblem)

		if (invalid.length) {
			throw new TrainingConfigError(
				ConfigErrorKind.Value,
				`receipt ${named} component_sequence must contain bare component tags, got ${pythonRepr(invalid)}`
			)
		}
	}
}

function validateValidationCoverage(entries: readonly ConfigInstance[]): void {
	for (const entry of entries) {
		const country = field(entry, "country")
		const split = field(entry, "split")
		const minRows = field(entry, "min_rows")
		const minStreetRows = field(entry, "min_street_rows")
		const named = pythonRepr(country)

		if (typeof country !== "string" || !country.trim()) {
			throw new TrainingConfigError(
				ConfigErrorKind.Value,
				"every data.required_validation_coverage entry needs a country"
			)
		}

		if (split !== "val" && split !== "test") {
			throw new TrainingConfigError(
				ConfigErrorKind.Value,
				`validation coverage for ${named} names split ${pythonRepr(split)}; only 'val' and 'test' are held out`
			)
		}

		if (typeof minRows !== "bigint" || typeof minStreetRows !== "bigint") {
			throw new TrainingConfigError(ConfigErrorKind.Type, `validation coverage for ${named} needs integer minimums`)
		}

		if (minRows <= 0n) {
			throw new TrainingConfigError(ConfigErrorKind.Value, `validation coverage for ${named} min_rows must be positive`)
		}

		if (minStreetRows < 0n) {
			throw new TrainingConfigError(
				ConfigErrorKind.Value,
				`validation coverage for ${named} min_street_rows cannot be negative`
			)
		}

		// Street rows are a subset of rows, so this floor can never pass and is a config error.
		if (minStreetRows > minRows) {
			throw new TrainingConfigError(
				ConfigErrorKind.Value,
				`validation coverage for ${named} asks for ${minStreetRows} street rows ` +
					`within ${minRows} rows, which no split can satisfy`
			)
		}
	}

	if (
		hasRepeat(entries.map((entry) => `${field(entry, "country") as string}\u0000${field(entry, "split") as string}`))
	) {
		throw new TrainingConfigError(
			ConfigErrorKind.Value,
			"data.required_validation_coverage entries must be unique per country and split"
		)
	}
}

function validateLabelSupport(floors: readonly ConfigInstance[]): void {
	for (const floor of floors) {
		const label = field(floor, "label")
		const split = field(floor, "split")
		const minRows = field(floor, "min_rows")

		if (typeof label !== "string" || !label.trim() || label === "O" || label.includes("-")) {
			throw new TrainingConfigError(
				ConfigErrorKind.Value,
				`every data.required_validation_label_support entry needs a bare component tag, got ${pythonRepr(label)}`
			)
		}

		if (split !== "val" && split !== "test") {
			throw new TrainingConfigError(
				ConfigErrorKind.Value,
				`label support for ${pythonRepr(label)} names split ${pythonRepr(split)}; only 'val' and 'test' are held out`
			)
		}

		if (typeof minRows !== "bigint" || minRows <= 0n) {
			throw new TrainingConfigError(
				ConfigErrorKind.Value,
				`label support for ${pythonRepr(label)} min_rows must be a positive integer`
			)
		}
	}

	if (hasRepeat(floors.map((floor) => `${field(floor, "label") as string}\u0000${field(floor, "split") as string}`))) {
		throw new TrainingConfigError(
			ConfigErrorKind.Value,
			"data.required_validation_label_support entries must be unique per label and split"
		)
	}
}

/**
 * The value a field takes from a YAML value, as `_coerce` converts it.
 */
function coerceField(dst: ConfigInstance, key: string, value: PythonValue, context: MergeContext): ConfigValue {
	const isData = dst.spec.className === "DataConfig"

	if (isData && key === "required_corpus_receipts") {
		const receipts = mergeElements(value, CORPUS_RECEIPT_SECTION, "data.required_corpus_receipts", context)

		validateCorpusReceipts(receipts)

		return receipts as unknown as PythonValue
	}

	if (isData && key === "required_validation_coverage") {
		const entries = mergeElements(value, VALIDATION_COVERAGE_SECTION, "data.required_validation_coverage", context)

		validateValidationCoverage(entries)

		return entries as unknown as PythonValue
	}

	if (isData && key === "required_validation_label_support") {
		const floors = mergeElements(value, LABEL_SUPPORT_SECTION, "data.required_validation_label_support", context)

		validateLabelSupport(floors)

		return floors as unknown as PythonValue
	}

	if (isData && key === "country_weights" && value instanceof Map) {
		for (const country of value.keys()) {
			if (typeof country === "string") continue

			throw new TrainingConfigError(
				ConfigErrorKind.Value,
				`country_weights has a non-string key ${pythonRepr(country)} (${pythonTypeName(country)}). ` +
					"This is almost certainly the YAML 1.1 Norway problem: an unquoted `NO:` parses " +
					'as the boolean false. Quote it — `"NO": 1.0` — and re-check every other code.'
			)
		}
	}

	if (typeof value !== "string") return value

	const annotation = dst.spec.fields[key]!.annotation

	if (annotation === "float") return pythonFloatOf(value) ?? value

	if (annotation === "int") return pythonIntOf(value) ?? value

	return value
}

/**
 * Options for {@linkcode readTrainingConfig}.
 */
export interface ReadTrainingConfigOptions {
	/**
	 * Refuses an unknown key.
	 *
	 * Every training entry point stays strict, because a skipped key leaves a setting at its default.
	 * Only tooling that reads part of a config turns it off.
	 *
	 * @default true
	 */
	strict?: boolean
}

/**
 * Loads YAML text over the schema defaults, as `load_config` loads a file.
 * `source` names the file in a refusal.
 *
 * @throws {TrainingConfigError} for an unknown key, a malformed floor list or a non-string country key.
 */
export function readTrainingConfigText(
	text: string,
	source: string,
	options: ReadTrainingConfigOptions = {}
): ConfigInstance {
	const config = defaultConfigInstance()
	const parsed = parsePythonYAML(text, source)
	const data = pythonTruthy(parsed) ? parsed : new Map()

	if (!(data instanceof Map)) {
		throw new TrainingConfigError(ConfigErrorKind.Value, `expected top-level mapping in ${source}`)
	}

	mergeIntoConfig(config, data, { strict: options.strict ?? true, source })

	return config
}

/**
 * Loads the YAML file at `path` over the schema defaults, as `load_config` does.
 */
export async function readTrainingConfig(
	path: PathBuilderLike,
	options: ReadTrainingConfigOptions = {}
): Promise<ConfigInstance> {
	return readTrainingConfigText(await readLocalTextFile(path), path.toString(), options)
}

/**
 * A mapping key a JS object moves ahead of its other keys, losing the YAML order.
 */
const ARRAY_INDEX_KEY = /^(?:0|[1-9][0-9]*)$/

/**
 * The JSON form of a loaded value: an instance or mapping becomes an object in its order, an int a number.
 */
function toPlain(value: ConfigValue, path: string): unknown {
	if (isInstance(value)) {
		return Object.fromEntries([...value.values].map(([name, entry]) => [name, toPlain(entry, `${path}.${name}`)]))
	}

	if (value instanceof Map) {
		const entries: Array<[string, unknown]> = []

		for (const [key, entry] of value) {
			if (typeof key !== "string") {
				throw new TrainingConfigError(
					ConfigErrorKind.Type,
					`${path} has the non-string key ${pythonRepr(key)} (${pythonTypeName(key)}); quote it in the YAML`
				)
			}

			if (ARRAY_INDEX_KEY.test(key)) {
				throw new TrainingConfigError(
					ConfigErrorKind.Value,
					`${path} has the key ${pythonRepr(key)}, which a JSON object reader moves ahead of the other keys`
				)
			}

			entries.push([key, toPlain(entry, `${path}.${key}`)])
		}

		return Object.fromEntries(entries)
	}

	if (Array.isArray(value)) return value.map((entry, index) => toPlain(entry, `${path}[${index}]`))

	if (typeof value === "bigint") {
		if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
			throw new TrainingConfigError(ConfigErrorKind.Value, `${path} holds ${value}, beyond a float64's exact integers`)
		}

		return Number(value)
	}

	return value
}

/**
 * Checks a loaded config's values against their declared types and returns them as JSON values.
 *
 * @throws {TrainingConfigError} naming every field whose value its declaration does not admit.
 */
export function typedTrainingConfig(config: ConfigInstance, source: string): TrainingConfig {
	const result = TrainingConfigSchema.safeParse(toPlain(config, "config"))

	if (!result.success) {
		const problems = result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`)

		throw new TrainingConfigError(
			ConfigErrorKind.Type,
			`${source} holds values their fields do not declare:\n  ${problems.join("\n  ")}`
		)
	}

	return result.data
}

/**
 * The corpus sources a config admits: every positive `source_weights` or `source_reps` key, sorted.
 *
 * A config without `source_weights` admits every source its corpus holds and lists none of them.
 */
export function admittedTrainingSources(config: TrainingConfig): string[] {
	const positive = (weights: Record<string, number> | null) =>
		Object.entries(weights ?? {})
			.filter(([, weight]) => weight > 0)
			.map(([source]) => source)

	return [...new Set([...positive(config.data.source_weights), ...positive(config.data.source_reps)])].toSorted()
}

/**
 * The version of the built corpus a config trains on: `data.corpus_dir`'s last segment without `corpus-`.
 */
export function trainingCorpusVersion(config: TrainingConfig): string {
	const name = config.data.corpus_dir.split("/").findLast((segment) => segment && segment !== ".") ?? ""

	return name.startsWith("corpus-") ? name.slice("corpus-".length) : name
}

/**
 * `train.csv_log_path` with `{output_dir}` filled, as Python's `str.format` fills it.
 *
 * @throws When the template names another field.
 */
export function trainingCSVLogPath(config: TrainingConfig): string {
	return config.train.csv_log_path.replaceAll(/\{\{|\}\}|\{([^{}]*)\}/g, (match, name: string | undefined) => {
		if (match === "{{") return "{"

		if (match === "}}") return "}"

		if (name === "output_dir") return config.train.output_dir

		throw new TrainingConfigError(ConfigErrorKind.Key, pythonRepr(name ?? ""))
	})
}

/**
 * The register and corpus-source table an admission reads, when a caller has read them already.
 */
export interface TrainingAdmissionInputs {
	register: AddressSourceRegister
	inputs: CorpusSourceInputs
}

/**
 * Where a training config sets the override a refusal names.
 */
const CONFIG_OVERRIDE_HINT = "a config's data.unshippable_reason for a training run"

/**
 * Options for {@linkcode admitTrainingConfig}.
 */
export interface AdmitTrainingConfigOptions {
	/**
	 * Names the config in a refusal, as `training config v7.2.0-address-systems-60k.yaml`.
	 */
	context: string
	/**
	 * The committed register and table are read when omitted.
	 */
	rights?: TrainingAdmissionInputs
	log?: (line: string) => void
}

/**
 * Refuses a config that admits a source lacking a transform and train permission,
 * as `load_training_config` does.
 *
 * `data.unshippable_reason` admits the rest for a local experiment, and the record then reads not shippable.
 * A config without `source_weights` names no source to check, so it is refused unless that reason is set.
 *
 * @throws {SourceRightsError} naming each source, register row and missing permission.
 */
export async function admitTrainingConfig(
	config: TrainingConfig,
	options: AdmitTrainingConfigOptions
): Promise<SourceRightsRecord> {
	const reason = config.data.unshippable_reason

	if (config.data.source_weights === null && reason === null) {
		throw new SourceRightsError(
			options.context,
			[
				{
					source: "*",
					registerSource: null,
					licenseID: null,
					state: null,
					missing: [...TRAINING_OPERATIONS],
					because:
						"the config sets no source_weights, so it admits every source its corpus holds and names none to check",
				},
			],
			CONFIG_OVERRIDE_HINT
		)
	}

	const register = options.rights?.register ?? (await readAddressSourceRegister())
	const inputs = options.rights?.inputs ?? (await readCorpusSourceInputs(register))

	const admission = createSourceRightsAdmission(register, inputs, {
		context: options.context,
		unshippableReason: reason,
		corpusVersion: trainingCorpusVersion(config),
		overrideHint: CONFIG_OVERRIDE_HINT,
		log: options.log,
	})

	if (config.data.source_weights === null) {
		admission.admitUnverified("the corpus sources a config without source_weights admits")
	} else {
		admission.admitAll(admittedTrainingSources(config))
	}

	return admission.record()
}

/**
 * The versioned resolved config: every default applied and the admission result embedded.
 */
export interface ResolvedTrainingConfigDocument {
	schema_version: typeof RESOLVED_TRAINING_CONFIG_VERSION
	/**
	 * The YAML file the config was read from, absolute.
	 */
	config_path: string
	config_sha256: string
	config: TrainingConfig
	/**
	 * Values the Python loader computes from the config where a caller asks for them.
	 */
	derived: {
		admitted_sources: string[]
		corpus_version: string
		csv_log_path: string
	}
	source_rights: SourceRightsRecord
}

/**
 * Options for {@linkcode buildResolvedTrainingConfig}.
 */
export interface ResolvedTrainingConfigOptions {
	rights?: TrainingAdmissionInputs
	log?: (line: string) => void
}

/**
 * Reads, types and admits the config at `path`, and returns the resolved document.
 *
 * @throws {TrainingConfigError} for a config the loader or the schema refuses.
 * @throws {SourceRightsError} for a config that admits a source lacking a permission.
 */
export async function buildResolvedTrainingConfig(
	path: PathBuilderLike,
	options: ResolvedTrainingConfigOptions = {}
): Promise<ResolvedTrainingConfigDocument> {
	const absolute = resolvePath(path)
	const config = typedTrainingConfig(await readTrainingConfig(absolute), absolute)
	const name = absolute.split("/").at(-1) ?? absolute

	const sourceRights = await admitTrainingConfig(config, {
		context: `training config ${name}`,
		rights: options.rights,
		log: options.log,
	})

	return {
		schema_version: RESOLVED_TRAINING_CONFIG_VERSION,
		config_path: absolute,
		config_sha256: await sha256File(absolute),
		config,
		derived: {
			admitted_sources: admittedTrainingSources(config),
			corpus_version: trainingCorpusVersion(config),
			csv_log_path: trainingCSVLogPath(config),
		},
		source_rights: sourceRights,
	}
}

/**
 * Writes the resolved config for the YAML at `configPath` to `outPath` as JSON.
 */
export async function writeResolvedTrainingConfig(
	configPath: PathBuilderLike,
	outPath: PathBuilderLike,
	options: ResolvedTrainingConfigOptions = {}
): Promise<ResolvedTrainingConfigDocument> {
	const document = await buildResolvedTrainingConfig(configPath, options)

	await writeLocalJSONFile(document, outPath)

	return document
}
