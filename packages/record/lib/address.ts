/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { type ComponentDict, type FormatAddressOptions, formatAddress } from "@mailwoman/codex/address-format"
import { canonicalKey } from "@mailwoman/codex/address-key"

/**
 * A geographic coordinate (WGS84 decimal degrees).
 */
export interface GeoCoordinate {
	latitude: number
	longitude: number
}

/**
 * Names the geocoder resolution tier that produced a coordinate, matching `GeocodeResult.resolution_tier`.
 *
 * It is a local union so this package does not depend on the geocoder runtime.
 */
export type ResolutionTier = "address_point" | "interpolated" | "street" | "admin" | "venue" | "plus_code"

/**
 * One resolved admin-hierarchy ancestor (most specific first), for spelling-invariant blocking.
 */
export interface HierarchyNode {
	tag: string
	value: string
	placeID?: string
}

/**
 * A resolved geocode attached to an address record — the location signal the matcher scores on.
 */
export interface AddressGeocode {
	coordinate: GeoCoordinate
	tier: ResolutionTier

	/**
	 * Gives the uncertainty radius in meters, which is `null` on the admin tier
	 * and whenever the tier reports none.
	 */
	uncertaintyMeters: number | null

	/**
	 * Lists the resolved admin hierarchy from the locality up to the country.
	 */
	hierarchy?: HierarchyNode[]

	/**
	 * Marks a delivery point, such as a PO box, rather than a building,
	 * so the coordinate does not locate the addressee.
	 */
	poBox?: boolean

	/**
	 * Marks a multi-unit building whose records share one coordinate,
	 * so the coordinate cannot distinguish units.
	 */
	multiUnit?: boolean
}

/**
 * Describes the canonical address record: parsed components, the match key,
 * and optionally the formatted text, raw input and resolved geocode.
 */
export interface PostalAddress {
	/**
	 * Holds the parsed address components keyed by component tag.
	 */
	components: ComponentDict

	/**
	 * Holds the normalized, deterministic match key used for blocking, built by
	 * `canonicalKey` from `@mailwoman/codex/address-key`.
	 */
	canonicalKey: string

	/**
	 * Gives a human-readable single-line form for display.
	 */
	formatted?: string

	geocode?: AddressGeocode

	/**
	 * Keeps the original free-text input for provenance.
	 */
	raw?: string
}

/**
 * Options for {@linkcode toPostalAddress}.
 */
export interface ToPostalAddressOptions {
	/**
	 * Names the country, as an ISO-2 code or a name, used for formatting,
	 * and defaults to the `country` component.
	 */
	country?: string

	/**
	 * Supplies the original free-text input to keep as provenance.
	 */
	raw?: string

	/**
	 * Says whether to compute the `formatted` string, and defaults to `true`.
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

	const record: PostalAddress = {
		components,
		canonicalKey: canonicalKey(components),
	}

	if (opts.raw !== undefined) {
		record.raw = opts.raw
	}

	if (opts.format !== false) {
		const formatted = formatAddress(components, country, opts.formatOptions ?? { separator: ", " })

		if (formatted) {
			record.formatted = formatted
		}
	}

	return record
}

/**
 * Attach (or replace) a resolved geocode on an address record, returning a new record.
 */
export function withGeocode(record: PostalAddress, geocode: AddressGeocode): PostalAddress {
	return { ...record, geocode }
}
