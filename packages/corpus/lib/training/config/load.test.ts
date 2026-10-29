/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Tests the training config resolver: the strict merge, the floor-list validations, the Norway refusal, the
 *   source admission and the resolved document.
 *
 *   The cases port `corpus-python/tests/mailwoman_train/config/test_config_strict.py`,
 *   `test_country_weights_norway.py` and the config-loader cases of `test_source_rights.py`, so they run where
 *   Python does not. `load-python-parity.test.ts` compares the two loaders directly.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { temporaryDirectory, type TemporaryDirectory } from "@mailwoman/core/fs/temporary"
import { repoRootPath } from "@mailwoman/core/paths"
import { resolvePath } from "path-ts"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { readCorpusSourceInputs, SourceRightsError } from "#source-register/corpus-inputs"
import { readAddressSourceRegister } from "#source-register/register"
import {
	admitTrainingConfig,
	admittedTrainingSources,
	buildResolvedTrainingConfig,
	ConfigErrorKind,
	defaultConfigInstance,
	mergeIntoConfig,
	readTrainingConfig,
	readTrainingConfigText,
	TrainingConfigError,
	trainingCorpusVersion,
	trainingCSVLogPath,
	typedTrainingConfig,
	writeResolvedTrainingConfig,
	type TrainingAdmissionInputs,
} from "#training/config/load"
import { parsePythonYAML, type PythonMapping } from "#training/config/python-yaml"
import { RESOLVED_TRAINING_CONFIG_VERSION, type TrainingConfig } from "#training/config/schema"

const CONFIG_DIR = repoRootPath("corpus-python", "src", "mailwoman_train", "configs")

const load = (text: string, strict = true) => readTrainingConfigText(text, "probe.yaml", { strict })
const typedOf = (text: string): TrainingConfig => typedTrainingConfig(load(text), "probe.yaml")

function refusal(text: string): TrainingConfigError {
	try {
		load(text)
	} catch (error) {
		if (error instanceof TrainingConfigError) return error

		throw error
	}

	throw new Error("the config loaded")
}

let rights: TrainingAdmissionInputs

beforeAll(async () => {
	const register = await readAddressSourceRegister()

	rights = { register, inputs: await readCorpusSourceInputs(register) }
})

describe("readTrainingConfigText", () => {
	it("refuses an unknown nested key with its dotted path and the file", () => {
		const error = refusal("train:\n  reinit_label_rowz: [B-dependent_locality]\n  max_steps: 10\n")

		expect(error.kind).toBe(ConfigErrorKind.Key)
		expect(error.message).toContain("'train.reinit_label_rowz'")
		expect(error.message).toContain("probe.yaml")
		expect(error.message).toContain("TrainConfig has no field 'reinit_label_rowz'")
	})

	it("refuses an unknown top-level section", () => {
		expect(refusal("trainer:\n  max_steps: 10\n").message).toContain("Config has no field 'trainer'")
	})

	it("merges known keys and leaves every other field at its default", () => {
		const config = typedOf(
			"train:\n  max_steps: 123\n  reinit_label_rows: [B-dependent_locality]\n" +
				"model:\n  hidden_size: 384\n" +
				"data:\n  max_length: 96\n"
		)

		expect(config.train.max_steps).toBe(123)
		expect(config.train.reinit_label_rows).toEqual(["B-dependent_locality"])
		expect(config.model.hidden_size).toBe(384)
		expect(config.data.max_length).toBe(96)
		expect(config.train.learning_rate).toBe(5e-4)
		expect(config.data.country_weights).toEqual({ US: 1, FR: 1 })
	})

	it("reads an empty file as the defaults", () => {
		expect(typedOf("")).toEqual(typedTrainingConfig(defaultConfigInstance(), "defaults"))
	})

	it("converts a numeric string only under a field annotated int or float", () => {
		const config = load("train:\n  learning_rate: 5e-4\n  span_head_learning_rate: 5e-4\n  max_steps: '1_000'\n")
		const train = config.values.get("train") as ReturnType<typeof defaultConfigInstance>

		expect(train.values.get("learning_rate")).toBe(0.0005)
		expect(train.values.get("span_head_learning_rate")).toBe("5e-4")
		expect(train.values.get("max_steps")).toBe(1000n)
		expect(() => typedTrainingConfig(config, "probe.yaml")).toThrow("train.span_head_learning_rate")
	})

	it("refuses a top-level value that is not a mapping, and a key that is not a string", () => {
		expect(refusal("- data\n").message).toBe("expected top-level mapping in probe.yaml")
		expect(refusal("on: 1\n").message).toBe("attribute name must be string, not 'bool'")
	})

	it("skips unknown keys when not strict", () => {
		const config = typedTrainingConfig(load("train:\n  not_a_setting: 1\n  max_steps: 7\n", false), "probe.yaml")

		expect(config.train.max_steps).toBe(7)
		expect(config.train).not.toHaveProperty("not_a_setting")
	})

	it("is strict by default when merging a mapping", () => {
		const config = defaultConfigInstance()
		const src = parsePythonYAML("train:\n  classifier_learning_rates: 1.0e-4\n") as PythonMapping

		expect(() => mergeIntoConfig(config, src)).toThrow("train.classifier_learning_rates")
	})
})

describe("the Norway problem", () => {
	it("refuses a country_weights key that YAML 1.1 read as a boolean", () => {
		const error = refusal("data:\n  country_weights:\n    NO: 1.0\n    US: 1.0\n")

		expect(error.kind).toBe(ConfigErrorKind.Value)
		expect(error.message).toContain("Norway problem")
		expect(error.message).toContain("non-string key False (bool)")
	})

	it("admits a quoted NO", () => {
		expect(typedOf('data:\n  country_weights:\n    "NO": 1.0\n    US: 1.0\n').data.country_weights).toEqual({
			NO: 1,
			US: 1,
		})
	})
})

describe("required_corpus_receipts", () => {
	it("loads each entry over the receipt defaults", () => {
		const [receipt] = typedOf(
			"data:\n  required_corpus_receipts:\n    - name: ve-after-locality\n      min_draws: 100\n" +
				"      source: synth-trailing-region-structured\n      country: VE\n" +
				"      component_sequence: [locality, postcode, region]\n"
		).data.required_corpus_receipts

		expect(receipt).toEqual({
			name: "ve-after-locality",
			min_draws: 100,
			source: "synth-trailing-region-structured",
			country: "VE",
			component_sequence: ["locality", "postcode", "region"],
		})
	})

	it("refuses repeated names", () => {
		expect(
			refusal(
				"data:\n  required_corpus_receipts:\n    - {name: duplicate, source: one}\n    - {name: duplicate, source: two}\n"
			).message
		).toBe("data.required_corpus_receipts names must be unique")
	})

	it.each([
		["min_draws", "true", "receipt 'receipt' min_draws must be an integer"],
		["min_draws", "1.5", "receipt 'receipt' min_draws must be an integer"],
		["component_sequence", "locality", "receipt 'receipt' component_sequence must be a list of strings"],
		["component_sequence", "[locality, 7]", "receipt 'receipt' component_sequence must be a list of strings"],
		["name", "7", "corpus receipt name must be a string"],
	])("refuses %s: %s as a type error", (field, value, message) => {
		const error = refusal(`data:\n  required_corpus_receipts:\n    - name: receipt\n      ${field}: ${value}\n`)

		expect(error.kind).toBe(ConfigErrorKind.Type)
		expect(error.message).toBe(message)
	})

	it("refuses a BIO tag in a component sequence, naming every one", () => {
		expect(
			refusal(
				"data:\n  required_corpus_receipts:\n    - name: r\n      component_sequence: [locality, B-postcode, O]\n"
			).message
		).toBe("receipt 'r' component_sequence must contain bare component tags, got ['B-postcode', 'O']")
	})

	it("skips an unknown receipt key when not strict", () => {
		const config = typedTrainingConfig(
			load("data:\n  required_corpus_receipts:\n    - name: receipt\n      future_filter: value\n", false),
			"probe.yaml"
		)

		expect(config.data.required_corpus_receipts[0]).not.toHaveProperty("future_filter")
	})
})

describe("required_validation_coverage", () => {
	it("loads entries with the val split and no street floor by default", () => {
		expect(typedOf("data:\n  required_validation_coverage:\n    - {country: DE, min_rows: 10}\n").data).toMatchObject({
			required_validation_coverage: [{ country: "DE", split: "val", min_rows: 10, min_street_rows: 0 }],
		})
	})

	it.each([
		["{country: GB, split: train, min_rows: 1}", "only 'val' and 'test' are held out"],
		[
			"{country: FR, min_rows: 100, min_street_rows: 500}",
			"asks for 500 street rows within 100 rows, which no split can satisfy",
		],
		["{country: '  ', min_rows: 1}", "every data.required_validation_coverage entry needs a country"],
		["{country: GB, min_rows: 0}", "validation coverage for 'GB' min_rows must be positive"],
	])("refuses %s", (entry, message) => {
		expect(refusal(`data:\n  required_validation_coverage:\n    - ${entry}\n`).message).toContain(message)
	})

	it("refuses a repeated country and split", () => {
		expect(
			refusal(
				"data:\n  required_validation_coverage:\n    - {country: GB, split: val, min_rows: 10}\n" +
					"    - {country: GB, split: val, min_rows: 20}\n"
			).message
		).toBe("data.required_validation_coverage entries must be unique per country and split")
	})
})

describe("required_validation_label_support", () => {
	it("loads floors with the val split by default", () => {
		const floors = typedOf(
			"data:\n  required_validation_label_support:\n    - {label: po_box, min_rows: 100}\n" +
				"    - {label: unit, split: test, min_rows: 50}\n"
		).data.required_validation_label_support

		expect(floors).toEqual([
			{ label: "po_box", split: "val", min_rows: 100 },
			{ label: "unit", split: "test", min_rows: 50 },
		])
	})

	it("refuses a BIO tag, a train split and a repeated label and split", () => {
		expect(
			refusal("data:\n  required_validation_label_support:\n    - {label: B-po_box, min_rows: 1}\n").message
		).toContain("bare component tag, got 'B-po_box'")

		expect(
			refusal("data:\n  required_validation_label_support:\n    - {label: po_box, split: train}\n").message
		).toContain("only 'val' and 'test' are held out")

		expect(
			refusal(
				"data:\n  required_validation_label_support:\n    - {label: po_box, min_rows: 1}\n" +
					"    - {label: po_box, min_rows: 2}\n"
			).message
		).toContain("unique per label and split")
	})
})

describe("the derived values", () => {
	it("reads the corpus version from corpus_dir and fills the log path template", () => {
		const config = typedOf(
			"data:\n  corpus_dir: /data/corpus/versioned/v0.7.7-no-ppd/corpus-v0.7.7-no-ppd/\n" +
				"train:\n  output_dir: /data/out\n  csv_log_path: '{output_dir}/{{x}}/log.csv'\n"
		)

		expect(trainingCorpusVersion(config)).toBe("v0.7.7-no-ppd")
		expect(trainingCSVLogPath(config)).toBe("/data/out/{x}/log.csv")
	})

	it("admits every positive source_weights and source_reps key, sorted", () => {
		const config = typedOf("data:\n  source_weights: {ban: 1.0, rendered-gb: 0.0}\n  source_reps: {fragment-fr: 2}\n")

		expect(admittedTrainingSources(config)).toEqual(["ban", "fragment-fr"])
	})
})

describe("admitTrainingConfig", () => {
	const admit = (text: string, log?: (line: string) => void) =>
		admitTrainingConfig(typedOf(text), { context: "training config probe.yaml", rights, log })

	it("refuses a config admitting rendered-gb on the Price Paid Data row", async () => {
		await expect(admit("data:\n  source_weights:\n    ban: 1.0\n    rendered-gb: 6.0\n")).rejects.toThrow(
			"gb-property-building-1"
		)
	})

	it("reads a zero weight as declining the source", async () => {
		const record = await admit("data:\n  source_weights:\n    ban: 1.0\n    rendered-gb: 0.0\n")

		expect(record).toEqual({
			shippable: true,
			unshippable_reason: null,
			sources_checked: ["ban"],
			gaps: [],
			unverified: [],
		})
	})

	it("refuses a config without source_weights, which names nothing to check", async () => {
		const refused = admit("data:\n  max_length: 64\n")

		await expect(refused).rejects.toBeInstanceOf(SourceRightsError)
		await expect(refused).rejects.toThrow("sets no source_weights")
		await expect(refused).rejects.toThrow("(a config's data.unshippable_reason for a training run)")
	})

	it("admits under data.unshippable_reason and marks the run not shippable", async () => {
		const lines: string[] = []

		const record = await admit(
			"data:\n  unshippable_reason: local experiment\n  source_weights:\n    rendered-gb: 6.0\n",
			(line) => lines.push(line)
		)

		expect(record.shippable).toBe(false)
		expect(record.unshippable_reason).toBe("local experiment")
		expect(lines.join("\n")).toContain("UNSHIPPABLE training config probe.yaml")
	})

	it("records a config without source_weights as unverified under the override", async () => {
		const record = await admit("data:\n  unshippable_reason: local experiment\n", () => {})

		expect(record).toEqual({
			shippable: false,
			unshippable_reason: "local experiment",
			sources_checked: [],
			gaps: [],
			unverified: ["the corpus sources a config without source_weights admits"],
		})
	})

	it("refuses the published model's config at launch", async () => {
		const config = typedTrainingConfig(
			await readTrainingConfig(resolvePath(CONFIG_DIR, "v7.2.0-address-systems-60k.yaml")),
			"v7.2.0"
		)

		expect(admittedTrainingSources(config)).toContain("rendered-gb")

		await expect(admitTrainingConfig(config, { context: "training config v7.2.0", rights })).rejects.toThrow(
			"rendered-gb reads register source gb-property-building-1"
		)
	})

	it("judges a built corpus by the inputs that built it", async () => {
		const config = typedTrainingConfig(
			await readTrainingConfig(resolvePath(CONFIG_DIR, "v7.7.0-no-ppd-60k.yaml")),
			"v7.7.0"
		)

		await expect(admitTrainingConfig(config, { context: "training config v7.7.0", rights })).rejects.toThrow(
			"fragment-assay reads register source us-geodata-aggregate-3"
		)
	})
})

describe("writeResolvedTrainingConfig", () => {
	let scratch: TemporaryDirectory

	beforeAll(async () => {
		scratch = await temporaryDirectory("mailwoman-resolved-config-")
	})

	afterAll(async () => {
		await scratch[Symbol.asyncDispose]()
	})

	it("writes the versioned document with every default, the absolute path and the admission record", async () => {
		const out = scratch.path("resolved.json")
		const written = await writeResolvedTrainingConfig(resolvePath(CONFIG_DIR, "v8-cjk-regs.yaml"), out, { rights })
		const read = await readLocalJSONFile<typeof written>(out)

		expect(read).toEqual(written)
		expect(read.schema_version).toBe(RESOLVED_TRAINING_CONFIG_VERSION)
		expect(read.config_path).toBe(resolvePath(CONFIG_DIR, "v8-cjk-regs.yaml"))
		expect(read.config_sha256).toMatch(/^[0-9a-f]{64}$/)
		expect(read.source_rights.shippable).toBe(true)
		expect(read.derived.admitted_sources).toEqual(read.source_rights.sources_checked)
		expect(Object.keys(read.config.train)).toContain("trackio_private")
	})

	it("refuses a config whose admission fails, writing nothing", async () => {
		await expect(
			buildResolvedTrainingConfig(resolvePath(CONFIG_DIR, "v7.2.0-address-systems-60k.yaml"), { rights })
		).rejects.toBeInstanceOf(SourceRightsError)
	})
})
