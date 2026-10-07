/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The deterministic row id for a source that publishes no primary key of its own.
 *
 * A CSV row or GeoJSON feature often has no stable identifier. The runner still needs one, so
 * deduplication and holdout manifests agree across reruns and a run can resume. These functions
 * derive it by hashing the adapter id together with a canonical serialization of the row's values.
 *
 * The separator bytes are part of the hashed stream, so changing them changes every id in every
 * built corpus.
 */

import type { ComponentTag } from "@mailwoman/codex/component"
import { sha256Hex } from "@mailwoman/core/hash"

/**
 * The deterministic content-addressed source id for a row, keyed by its components.
 *
 * The output is `<adapterID>-<first 12 hex characters of sha256>`.
 * Twelve hex characters give 48 bits, about 17 million rows per adapter
 * before the expected collision count passes 1.
 * An adapter above that extends the prefix.
 */
export function stableSourceID(adapterID: string, components: Partial<Record<ComponentTag, string>>): string {
	return stableSourceIDFromParts(adapterID, components)
}

/**
 * {@linkcode stableSourceID} over arbitrary disambiguator keys, such as a variant index
 * or a slot number that is not a `ComponentTag`.
 *
 * Both functions sort and hash every key handed in, so only the key vocabulary differs.
 * The narrower signature above stops an adapter from hashing a misspelled component name.
 */
export function stableSourceIDFromParts(
	adapterID: string,
	parts: Readonly<Record<string, string | undefined>>
): string {
	const sortedKeys = Object.keys(parts).toSorted()
	const payload = sortedKeys.map((k) => `${k}=${parts[k] ?? ""}`).join("\u001F")
	// One `update` over the joined string rather than three chained ones — identical byte stream
	// either way, but the separator has to stay inline or every id in every built corpus changes.
	const digest = sha256Hex(`${adapterID}\u001E${payload}`)

	return `${adapterID}-${digest.slice(0, 12)}`
}
