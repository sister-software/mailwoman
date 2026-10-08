/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Types for decoded address trees and the labeled tokens they are built from.
 */

import { type BIOLabel, COMPONENT_TAGS, type ComponentTag } from "@mailwoman/codex/component"
import { z } from "zod"

import { isRecordLike } from "#objects"

/**
 * One token with its predicted label, confidence and offsets into the original input.
 */
export interface DecoderToken {
	/**
	 * The token piece as emitted, including any leading-space marker.
	 */
	piece: string
	/**
	 * The inclusive start offset in the original input.
	 */
	start: number
	/**
	 * The exclusive end offset in the original input.
	 */
	end: number
	/**
	 * The predicted BIO label.
	 */
	label: BIOLabel
	/**
	 * The softmax confidence of the label, in `[0, 1]`.
	 */
	confidence: number
}

/**
 * An address component span and the components it contains.
 */
export interface AddressNode {
	tag: ComponentTag
	value: string
	start: number
	end: number
	confidence: number
	children: AddressNode[]
	/**
	 * The origin of the node, such as `rule`, `neural` or `resolver`.
	 */
	source?: string
	/**
	 * An ID within `source`, such as a rule ID, model version or place ID.
	 */
	sourceID?: string
	/**
	 * The latitude of the resolved place's centroid.
	 */
	lat?: number
	/**
	 * The longitude of the resolved place's centroid.
	 */
	lon?: number
	/**
	 * The normalized place URI.
	 * `sourceID` holds the resolver-specific ID.
	 */
	placeID?: string
	/**
	 * Diagnostic metadata.
	 */
	metadata?: Record<string, unknown>
	/**
	 * Runner-up places in score order.
	 * The selected place is in `placeID`, `lat` and `lon`.
	 *
	 * The type is `unknown` so this module does not import the resolver's `ResolvedPlace`.
	 */
	alternatives?: ReadonlyArray<unknown>
	/**
	 * Other tags assigned to the same span, each with its own resolved place.
	 */
	interpretations?: ReadonlyArray<Interpretation>
	/**
	 * The ISO 15924 script of the span.
	 *
	 * `Zyyy` means no specific script.
	 * An absent value means the script is unknown.
	 */
	script?: string
}

/**
 * A secondary tag assigned to an address span.
 */
export interface Interpretation {
	tag: ComponentTag
	/**
	 * The normalized place URI for this tag.
	 */
	placeID?: string
	sourceID?: string
	/**
	 * The centroid of this tag's place.
	 */
	lat?: number
	lon?: number
	confidence?: number
	metadata?: Record<string, unknown>
}

/**
 * Every recognized address component tag, as a schema.
 */
export const ComponentTagSchema = z
	.enum(COMPONENT_TAGS)
	.meta({ id: "ComponentTag", description: "A recognized address component tag." })

/**
 * The wire schema of an {@link AddressNode}.
 *
 * The node is recursive, so the schema checks only that the value is an object and documents the rest.
 */
export const AddressNodeSchema = z.custom<AddressNode>(isRecordLike).meta({
	id: "AddressNode",
	type: "object",
	additionalProperties: true,
	description: "A decoded address-tree node: a tag, its span, and its children.",
})

/**
 * The wire schema of an {@link AddressTree}.
 */
export const AddressTreeSchema = z.custom<AddressTree>(isRecordLike).meta({
	id: "AddressTree",
	type: "object",
	properties: { raw: { type: "string" }, roots: { type: "array", items: { type: "object" } } },
	required: ["raw", "roots"],
	additionalProperties: true,
	description: "A decoded address: the raw input and its top-level component nodes.",
})

/**
 * One parsed component in reading order: a `ComponentTag` and the text it covers.
 *
 * HTTP surfaces put a list of these beside the full {@link AddressTree}.
 */
export const ParseComponentSchema = z
	.object({ tag: z.string(), value: z.string() })
	.meta({ id: "ParseComponent", description: "One parsed component in reading order." })

export type ParseComponent = z.infer<typeof ParseComponentSchema>

/**
 * A decoded address with its top-level components in source order.
 */
export interface AddressTree {
	/**
	 * The original input, kept for round-tripping and XML output.
	 */
	raw: string
	roots: AddressNode[]
	/**
	 * The addressing system that selects the containment hierarchy.
	 *
	 * @defaultValue the Western hierarchy.
	 */
	system?: AddressSystem
	/**
	 * The country predicted by the parse-time locale classifier, when it was confident.
	 */
	localeCountry?: { country: string; confidence: number }
}

/**
 * The addressing hierarchy of a decoded tree.
 * `japanese` currently uses the Western hierarchy.
 */
export type AddressSystem = "western" | "japanese" | (string & {})
