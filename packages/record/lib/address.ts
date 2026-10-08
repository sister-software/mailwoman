/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { ResolutionTier } from "@mailwoman/annotations/geo"
import { type FormatAddressOptions, formatAddress } from "@mailwoman/codex/address/format"
import { canonicalKey } from "@mailwoman/codex/address/key"
import type { ComponentDict } from "@mailwoman/codex/address/render"
import type { GeoCoordinate } from "@mailwoman/spatial"

/**
 * One resolved admin-hierarchy ancestor (most specific first), for spelling-invariant blocking.
 */
export interface HierarchyNode {
	tag: string
	value: string
	placeID: string | null
}

/**
 * A resolved geocode attached to an address record — the location signal the matcher scores on.
 */
export interface AddressGeocode {
	coordinate: GeoCoordinate
	tier: ResolutionTier

	/**
	 * Gives the uncertainty radius in meters.
	 *
	 * It is `null` on the admin tier and whenever the tier reports none.
	 */
	uncertaintyMeters: number | null

	/**
	 * Lists the resolved admin hierarchy from the locality up to the country.
	 */
	hierarchy: HierarchyNode[] | null

	/**
	 * Marks a delivery point, such as a PO box, rather than a building,
	 * so the coordinate does not locate the addressee.
	 */
	poBox: boolean | null

	/**
	 * Marks a multi-unit building whose records share one coordinate,
	 * so the coordinate cannot distinguish units.
	 */
	multiUnit: boolean | null
}

/**
 * Describes the canonical address record with parsed components plus a match key.
 *
 * It may also include formatted text, raw input or a resolved geocode.
 */
export interface PostalAddress {
	/**
	 * Holds the parsed address components keyed by component tag.
	 */
	components: ComponentDict

	/**
	 * Holds the normalized, deterministic match key used for blocking, built by
	 * `canonicalKey` from `@mailwoman/codex/address/key`.
	 */
	canonicalKey: string

	/**
	 * Gives a human-readable single-line form for display.
	 */
	formatted: string | null

	geocode: AddressGeocode | null

	/**
	 * Keeps the original free-text input for provenance.
	 */
	raw: string | null
}

/**
 * Options for {@linkcode toPostalAddress}.
 */
export interface ToPostalAddressOptions {
	/**
	 * Supplies the country for formatting as an ISO-2 code or a name.
	 * It defaults to the `country` component.
	 */
	country?: string | null

	/**
	 * Supplies the original free-text input to keep as provenance.
	 */
	raw?: string | null

	/**
	 * Indicates whether to compute the `formatted` string.
	 * It defaults to `true`.
	 */
	format?: boolean

	/**
	 * Passes options to the formatter, defaulting to a single line joined with `", "`.
	 */
	formatOptions?: FormatAddressOptions
}

/**
 * Builds a {@linkcode PostalAddress} from parsed components, always filling the match key
 * and, unless `format` is `false`, the formatted address.
 *
 * Attach a geocode separately with {@linkcode withGeocode}.
 */
export function toPostalAddress(components: ComponentDict, opts: ToPostalAddressOptions = {}): PostalAddress {
	const country = opts.country ?? components.country ?? ""

	const formatted =
		opts.format === false ? null : formatAddress(components, country, opts.formatOptions ?? { separator: ", " })

	return {
		components,
		canonicalKey: canonicalKey(components),
		formatted: formatted || null,
		geocode: null,
		raw: opts.raw ?? null,
	}
}

/**
 * Attach (or replace) a resolved geocode on an address record, returning a new record.
 */
export function withGeocode(record: PostalAddress, geocode: AddressGeocode): PostalAddress {
	return { ...record, geocode }
}
