/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The training run config: every section, field and default of `corpus-python/src/mailwoman_train/config/schema.py`,
 *   in its declaration order, and the zod schema of the resolved config the Rust trainer and sampler read.
 *
 *   Each field records its Python annotation because the loader's coercion reads it. A numeric string converts
 *   only for a field annotated exactly `int` or `float`, so `5e-4` under `learning_rate` becomes a float while the
 *   same string under `span_head_learning_rate`, annotated `float | None`, stays a string. An integer default is a
 *   `bigint` because the loader tests the Python type of each receipt and coverage minimum.
 */

import { z } from "zod"

import type { PythonValue } from "#training/config/python-yaml"

/**
 * The version of the resolved config document.
 * A change to a field's name, type or meaning increments it.
 */
export const RESOLVED_TRAINING_CONFIG_VERSION = 1

/**
 * One dataclass field: its Python annotation, its default and the type its resolved value takes.
 */
export interface ConfigFieldSpec<Output extends z.ZodType = z.ZodType> {
	annotation: string
	/**
	 * Builds a fresh default, so a list or mapping default is never shared between configs.
	 */
	default: () => PythonValue
	output: Output
	/**
	 * The nested dataclass a mapping merges into, as `Config.data` names `DataConfig`.
	 */
	section?: ConfigSectionSpec
}

/**
 * One dataclass, named as the Python loader's unknown-key message names it.
 */
export interface ConfigSectionSpec<Fields extends Record<string, ConfigFieldSpec> = Record<string, ConfigFieldSpec>> {
	className: string
	fields: Fields
}

const int = (value: bigint) => ({ annotation: "int", default: () => value, output: z.number().int() })
const float = (value: number) => ({ annotation: "float", default: () => value, output: z.number() })
const bool = (value: boolean) => ({ annotation: "bool", default: () => value, output: z.boolean() })
const str = (value: string) => ({ annotation: "str", default: () => value, output: z.string() })
const optionalStr = () => ({ annotation: "str | None", default: () => null, output: z.string().nullable() })

const optionalInt = (value: bigint | null = null) => ({
	annotation: "int | None",
	default: () => value,
	output: z.number().int().nullable(),
})

const optionalFloat = () => ({ annotation: "float | None", default: () => null, output: z.number().nullable() })
const strList = () => ({ annotation: "list[str]", default: (): PythonValue => [], output: z.array(z.string()) })

const intList = (value: readonly bigint[]) => ({
	annotation: "list[int]",
	default: (): PythonValue => [...value],
	output: z.array(z.number().int()),
})

const floatMap = (value: ReadonlyArray<readonly [string, number]>) => ({
	annotation: "dict[str, float]",
	default: (): PythonValue => new Map<PythonValue, PythonValue>(value),
	output: z.record(z.string(), z.number()),
})

const optionalFloatMap = () => ({
	annotation: "dict[str, float] | None",
	default: () => null,
	output: z.record(z.string(), z.number()).nullable(),
})

/**
 * The zod object a section's resolved values form, refusing a key the section does not declare.
 */
function sectionOutput<Fields extends Record<string, ConfigFieldSpec>>(fields: Fields) {
	const shape = Object.fromEntries(Object.entries(fields).map(([name, field]) => [name, field.output])) as {
		[Name in keyof Fields]: Fields[Name]["output"]
	}

	return z.strictObject(shape)
}

const sectionList = <Fields extends Record<string, ConfigFieldSpec>>(element: ConfigSectionSpec<Fields>) => ({
	annotation: `list[${element.className}]`,
	default: (): PythonValue => [],
	output: z.array(sectionOutput(element.fields)),
})

/**
 * The Python CorpusReceiptConfig dataclass: a floor on the training draws that
 * hold one source, country and component sequence.
 */
export const CORPUS_RECEIPT_SECTION = {
	className: "CorpusReceiptConfig",
	fields: {
		name: str(""),
		min_draws: int(1n),
		source: optionalStr(),
		country: optionalStr(),
		component_sequence: strList(),
	},
} as const satisfies ConfigSectionSpec

/**
 * The Python ValidationCoverageConfig dataclass: a floor on one country's rows in a held-out split.
 */
export const VALIDATION_COVERAGE_SECTION = {
	className: "ValidationCoverageConfig",
	fields: {
		country: str(""),
		split: str("val"),
		min_rows: int(1n),
		min_street_rows: int(0n),
	},
} as const satisfies ConfigSectionSpec

/**
 * The Python LabelSupportConfig dataclass: a floor on the rows of a held-out
 * split's trainer draw that hold one component label.
 */
export const LABEL_SUPPORT_SECTION = {
	className: "LabelSupportConfig",
	fields: {
		label: str(""),
		split: str("val"),
		min_rows: int(1n),
	},
} as const satisfies ConfigSectionSpec

/**
 * `DataConfig`.
 *
 * `unshippable_reason` admits a source whose register rows lack an elected decision
 * permitting transform and train, and marks the run not shippable.
 */
export const DATA_SECTION = {
	className: "DataConfig",
	fields: {
		corpus_dir: str("/data/corpus/versioned/v0.1.0/corpus-v0.1.0"),
		tokenizer_dir: str("/data/models/tokenizer/v0.1.0"),
		max_length: int(128n),
		country_weights: floatMap([
			["US", 1],
			["FR", 1],
		]),
		source_weights: optionalFloatMap(),
		source_reps: optionalFloatMap(),
		unshippable_reason: optionalStr(),
		required_corpus_receipts: sectionList(CORPUS_RECEIPT_SECTION),
		required_validation_coverage: sectionList(VALIDATION_COVERAGE_SECTION),
		required_validation_label_support: sectionList(LABEL_SUPPORT_SECTION),
		train_rows_per_epoch: optionalInt(),
		val_rows: optionalInt(4096n),
		coarse_filter: bool(true),
		augment_directional_prob: float(0),
		augment_region_prob: float(0),
		augment_glue_prob: float(0),
		augment_ordinal_prob: float(0),
		augment_case_prob: float(0),
		augment_punct_drop_prob: float(0),
		augment_upper_case_prob: float(0),
		augment_postcode_move_prob: float(0),
		augment_grouping_prob: float(0),
		code_unit_features: bool(false),
		augment_exclude_sources: strList(),
		anchor_lookup_path: optionalStr(),
		gazetteer_lexicon_path: optionalStr(),
		country_lexicon_path: optionalStr(),
		street_type_lexicon_path: optionalStr(),
		locality_surface_lexicon_path: optionalStr(),
		gazetteer_choreography: bool(false),
		char_mode: str("off"),
		char_vocab_path: optionalStr(),
		char_ctx: int(0n),
		max_unit_width: int(16n),
		max_units: optionalInt(),
		label_set: str("stage3"),
		affix_relabel_lexicon_path: optionalStr(),
		anchor_paint_mode: str("gold"),
		anchor_value_mode: str("posterior_latlon"),
		region_centroids_path: optionalStr(),
	},
} as const satisfies ConfigSectionSpec

/**
 * `ModelConfig`.
 */
export const MODEL_SECTION = {
	className: "ModelConfig",
	fields: {
		hidden_size: int(256n),
		num_hidden_layers: int(6n),
		num_attention_heads: int(4n),
		intermediate_size: int(1024n),
		max_position_embeddings: int(128n),
		type_vocab_size: int(1n),
		hidden_dropout_prob: float(0.1),
		attention_probs_dropout_prob: float(0.1),
		use_crf: bool(false),
		label_smoothing: float(0),
		crf_loss_weight: float(0.1),
		crf_normalization: str("per_sequence"),
		crf_fp32: bool(false),
		class_weights: optionalFloatMap(),
		use_phrase_priors: bool(false),
		phrase_feature_dim: int(10n),
		use_locale_conditioning: bool(false),
		locale_loss_weight: float(0),
		use_address_system_head: bool(false),
		address_system_loss_weight: float(0),
		use_locale_hint: bool(false),
		locale_hint_drop_prob: float(0.5),
		locale_hint_noise_prob: float(0.05),
		use_postcode_anchor: bool(false),
		inject_first_token: bool(false),
		use_gazetteer_anchor: bool(false),
		use_affix_head: bool(false),
		use_deploc_head: bool(false),
		use_conventions_loss_mask: bool(false),
		use_span_boundary_head: bool(false),
		span_boundary_loss_weight: float(0),
		use_span_scorer: bool(false),
		span_loss_weight: float(0),
		span_dim: int(128n),
		max_span: int(8n),
		gazetteer_feature_dim: int(5n),
		use_country_anchor: bool(false),
		country_feature_dim: int(2n),
		country_ambiguous_scale: float(1),
		use_street_type_anchor: bool(false),
		street_type_feature_dim: int(1n),
		use_locality_surface_anchor: bool(false),
		locality_surface_feature_dim: int(2n),
		use_code_unit_anchor: bool(false),
		code_unit_feature_dim: int(5n),
		use_char_embed: bool(false),
		char_embed_dim: int(64n),
		char_kernel_sizes: intList([3n, 4n, 5n]),
	},
} as const satisfies ConfigSectionSpec

/**
 * `TrainConfig`.
 *
 * `csv_log_path` is a template whose `{output_dir}` the resolver fills.
 */
export const TRAIN_SECTION = {
	className: "TrainConfig",
	fields: {
		output_dir: str("/data/models/checkpoints/stage1-coarse"),
		seed: int(42n),
		batch_size: int(256n),
		eval_batch_size: int(512n),
		grad_accum_steps: int(1n),
		learning_rate: float(5e-4),
		weight_decay: float(0.01),
		span_head_learning_rate: optionalFloat(),
		classifier_learning_rate: optionalFloat(),
		reinit_label_rows: strList(),
		warmup_steps: int(1000n),
		max_steps: int(50_000n),
		eval_every_steps: int(2000n),
		save_every_steps: int(5000n),
		log_every_steps: int(100n),
		precision: str("fp32"),
		num_workers: int(2n),
		csv_log_path: str("{output_dir}/train_log.csv"),
		grad_clip_norm: float(1),
		fisher_capture: bool(false),
		fisher_capture_last_n_steps: int(2000n),
		ewc_lambda: float(0),
		ewc_fisher_path: optionalStr(),
		ewc_reference: optionalStr(),
		lr_schedule: str("cosine"),
		cooldown_start_step: optionalInt(),
		gazetteer_curriculum: bool(false),
		evidence_curriculum: bool(false),
		evidence_noise_prob: float(0),
		objective: str("supervised"),
		mlm_mask_prob: float(0.15),
		init_from: str(""),
		freeze_encoder: bool(false),
		freeze_token_embeddings: bool(false),
		trainable_only_prefixes: strList(),
		trackio_enabled: bool(false),
		trackio_project: str("mailwoman"),
		trackio_space: str(""),
		trackio_run_name: str(""),
		trackio_private: bool(true),
	},
} as const satisfies ConfigSectionSpec

/**
 * `EvalConfig`.
 */
export const EVAL_SECTION = {
	className: "EvalConfig",
	fields: {
		golden_dir: str(""),
		val_jsonl: str(""),
	},
} as const satisfies ConfigSectionSpec

const section = <Fields extends Record<string, ConfigFieldSpec>>(spec: ConfigSectionSpec<Fields>) => ({
	annotation: spec.className,
	default: (): PythonValue => null,
	output: sectionOutput(spec.fields),
	section: spec as ConfigSectionSpec,
})

/**
 * `Config`: the four sections a YAML file's top-level mapping merges into.
 */
export const CONFIG_SECTION = {
	className: "Config",
	fields: {
		data: section(DATA_SECTION),
		model: section(MODEL_SECTION),
		train: section(TRAIN_SECTION),
		eval: section(EVAL_SECTION),
	},
} as const satisfies ConfigSectionSpec

/**
 * The resolved values of a config, refusing a missing field, an undeclared one,
 * and a value of the wrong type.
 */
export const TrainingConfigSchema = sectionOutput(CONFIG_SECTION.fields)

/**
 * The resolved values of a config, in the Python dataclasses' field order.
 */
export type TrainingConfig = z.infer<typeof TrainingConfigSchema>
