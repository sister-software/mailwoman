/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import {
	bioLabelsOf,
	DEFAULT_LABEL_SET,
	IGNORE_INDEX,
	LABEL_SETS,
	LOCALE_COUNTRIES,
	type LabelSetName,
} from "./labels.ts"

/**
 * The version of {@linkcode LabelSchema}'s layout.
 * A consumer refuses a schema whose version it does not read.
 */
export const LABEL_SCHEMA_VERSION = 1

/**
 * One label set: its tags in order and their BIO expansion, whose indices are the model's output indices.
 */
export interface LabelSchemaSet {
	tags: readonly string[]
	bio_labels: readonly string[]
}

/**
 * The label vocabulary the trainer, the row encoder and the serving runtime share,
 * as one serializable document.
 *
 * The TypeScript constants in `labels.ts` are its source.
 * Consumers in other languages read the committed `packages/neural/data/label-schema.v1.json`,
 * which `tools/emit-label-schema.run.ts` writes from these constants.
 */
export interface LabelSchema {
	schema_version: typeof LABEL_SCHEMA_VERSION
	default_label_set: LabelSetName
	ignore_index: number
	locale_countries: readonly string[]
	label_sets: Record<LabelSetName, LabelSchemaSet>
}

/**
 * Build the label schema from the TypeScript label constants.
 */
export function buildLabelSchema(): LabelSchema {
	const set = (name: LabelSetName): LabelSchemaSet => ({
		tags: [...LABEL_SETS[name]],
		bio_labels: [...bioLabelsOf(LABEL_SETS[name])],
	})

	const labelSets: Record<LabelSetName, LabelSchemaSet> = {
		stage3: set("stage3"),
		"stage3-jp": set("stage3-jp"),
		"stage3-cn": set("stage3-cn"),
		"stage3-cjk": set("stage3-cjk"),
		stage4: set("stage4"),
	}

	return {
		schema_version: LABEL_SCHEMA_VERSION,
		default_label_set: DEFAULT_LABEL_SET,
		ignore_index: IGNORE_INDEX,
		locale_countries: [...LOCALE_COUNTRIES],
		label_sets: labelSets,
	}
}
