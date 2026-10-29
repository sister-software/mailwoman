/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { forbiddenTagsByLocale } from "./address-system.ts"
import {
	bioLabelsOf,
	DEFAULT_LABEL_SET,
	IGNORE_INDEX,
	LABEL_SETS,
	LOCALE_COUNTRIES,
	type LabelSetName,
} from "./labels.ts"
import { headMapping, REFINES, SEMANTIC_TAG_REGISTRY_VERSION, SEMANTIC_TAGS, UNREFINED } from "./semantic-tags.ts"

/**
 * The version of {@linkcode LabelSchema}'s layout.
 *
 * A consumer refuses a schema whose version it does not read.
 * A section added beside the existing ones keeps the version, because every
 * reader looks its sections up by name.
 */
export const LABEL_SCHEMA_VERSION = 1

/**
 * The semantic tag registry: every tag by its global id, the refinements, and each set's head mapping.
 */
export interface LabelSchemaSemanticTags {
	registry_version: number
	/**
	 * Every registered tag.
	 * A tag's index is its global id.
	 */
	tags: readonly string[]
	refines: Readonly<Record<string, string>>
	/**
	 * The fine tags with no coarser equivalent, sorted.
	 */
	unrefined: readonly string[]
	/**
	 * Each label set's tags as global ids, in head order.
	 */
	head_mappings: Record<LabelSetName, readonly number[]>
}

/**
 * One address system as the schema references it: the append-only id the address-system
 * head indexes, and the component order that defines it.
 */
export interface LabelSchemaAddressSystem {
	id: number
	key: string
}

/**
 * The address systems the address-system head and the `locale_hint` input index.
 *
 * `@mailwoman/codex`'s layouts define them and `mailwoman dev generate address-systems`
 * assigns their ids in `registry`, which also maps each country and script to its system.
 * The schema lists every id in order, so the head width is `systems.length`
 * and `locale_hint`'s no-hint id is that width.
 */
export interface LabelSchemaAddressSystems {
	/**
	 * The registry's path from the repository root.
	 */
	registry: string
	systems: readonly LabelSchemaAddressSystem[]
}

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
	semantic_tags: LabelSchemaSemanticTags
	address_systems: LabelSchemaAddressSystems
	/**
	 * The tags the trainer's conventions loss mask forbids, by locale country.
	 * A locale country without an entry has none.
	 */
	conventions_forbidden_tags: Readonly<Record<string, readonly string[]>>
}

/**
 * Build the label schema from the TypeScript label constants, the semantic tag registry,
 * the address systems the registry at `addressSystems.registry` assigns, and the codex conventions.
 *
 * @throws When the address-system ids are not `0…n-1` in order.
 * The head's output layout requires that order.
 */
export function buildLabelSchema(addressSystems: LabelSchemaAddressSystems): LabelSchema {
	addressSystems.systems.forEach((system, index) => {
		if (system.id !== index) {
			throw new Error(`${addressSystems.registry}: address system ${index} has id ${system.id}`)
		}
	})

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
		semantic_tags: {
			registry_version: SEMANTIC_TAG_REGISTRY_VERSION,
			tags: [...SEMANTIC_TAGS],
			refines: { ...REFINES },
			unrefined: [...UNREFINED].toSorted(),
			head_mappings: {
				stage3: headMapping("stage3"),
				"stage3-jp": headMapping("stage3-jp"),
				"stage3-cn": headMapping("stage3-cn"),
				"stage3-cjk": headMapping("stage3-cjk"),
				stage4: headMapping("stage4"),
			},
		},
		address_systems: {
			registry: addressSystems.registry,
			systems: addressSystems.systems.map(({ id, key }) => ({ id, key })),
		},
		conventions_forbidden_tags: forbiddenTagsByLocale(),
	}
}
