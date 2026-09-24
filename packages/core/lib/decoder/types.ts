/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Types for decoded address trees and their token-level input. The tree preserves component
 *   containment and supports JSON, tuple, and XML projections.
 */

import type { BIOLabel, ComponentTag } from "@mailwoman/codex/component"

/**
 * Tokenizer output with predicted label, confidence, and offsets into the original input.
 */
export interface DecoderToken {
	/**
	 * Token piece as emitted, including any leading-space sentinel.
	 */
	piece: string
	/**
	 * Inclusive character offset in the original input.
	 */
	start: number
	/**
	 * Exclusive character offset in the original input.
	 */
	end: number
	/**
	 * Predicted BIO label.
	 */
	label: BIOLabel
	/**
	 * Softmax confidence for the label, in `[0, 1]`.
	 */
	confidence: number
}

/**
 * Address component span with any contained child components.
 */
export interface AddressNode {
	tag: ComponentTag
	value: string
	start: number
	end: number
	confidence: number
	children: AddressNode[]
	/**
	 * Origin of the assertion, such as `rule`, `neural`, or `resolver`.
	 */
	source?: string
	/**
	 * Identifier within `source`, such as a rule ID, model version, or place ID.
	 */
	sourceID?: string
	/**
	 * Resolver-selected centroid latitude.
	 */
	lat?: number
	/**
	 * Resolver-selected centroid longitude.
	 */
	lon?: number
	/**
	 * Normalized place URI, distinct from the resolver-specific `sourceID`.
	 */
	placeID?: string
	/**
	 * Optional metadata for diagnostics and downstream telemetry.
	 */
	metadata?: Record<string, unknown>
	/**
	 * Runner-up places ordered by score.
	 *
	 * The selected place is stored in `placeID`, `lat`, and `lon`.
	 * Typed as `unknown[]` to avoid importing the resolver's `ResolvedPlace` type.
	 */
	alternatives?: ReadonlyArray<unknown>
	/**
	 * Additional tags assigned to the same span, each with its own resolved place.
	 *
	 * Unlike `alternatives`, these entries represent different roles rather than runner-up places.
	 */
	interpretations?: ReadonlyArray<Interpretation>
	/**
	 * ISO 15924 script used by this span.
	 * `Zyyy` indicates no specific script; absence means unknown.
	 */
	script?: string
}

/**
 * Secondary role assigned to an address span.
 */
export interface Interpretation {
	tag: ComponentTag
	/**
	 * Normalized place URI for this role.
	 */
	placeID?: string
	sourceID?: string
	/**
	 * Centroid for this role's place.
	 */
	lat?: number
	lon?: number
	confidence?: number
	metadata?: Record<string, unknown>
}

/**
 * Decoded address with top-level components in source order.
 */
export interface AddressTree {
	/**
	 * Original input, preserved for round-tripping and XML output.
	 */
	raw: string
	roots: AddressNode[]
	/**
	 * Addressing system used to select the containment hierarchy.
	 * Defaults to the Western hierarchy.
	 */
	system?: AddressSystem
	/**
	 * Confident country prediction from the parse-time locale classifier.
	 * Absence means unknown.
	 */
	localeCountry?: { country: string; confidence: number }
}

/**
 * Addressing hierarchy selected for a decoded tree.
 * `japanese` currently uses the Western map.
 */
export type AddressSystem = "western" | "japanese" | (string & {})
