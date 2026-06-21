/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The canonical address record — the matcher's unit of address identity, and the canonical record the
 *   organization and contact records build on.
 *
 *   It is plain data: parser components + the formatter's match key + an optional resolved geocode,
 *   composed into one object. No ORM, no decorators, no schema-generation machinery — if we need a
 *   database we reach for Kysely at the call site, not a model layer here.
 *
 *   The geocode fields mirror mailwoman's `GeocodeResult` (tier + calibrated uncertainty + hierarchy)
 *   on purpose: that is the location signal the Fellegi-Sunter scorer weights its distance evidence
 *   by — two records sharing a `address_point` coordinate is strong agreement; sharing an
 *   `interpolated` centroid is weak; a PO-box / multi-unit coordinate is barely location agreement
 *   at all (the NAACCR precedent, see the geocode-first record-matching concept doc).
 */

import { type ComponentDict, type FormatAddressOptions, canonicalKey, formatAddress } from "@mailwoman/formatter"

/** A geographic coordinate (WGS84 decimal degrees). */
export interface GeoCoordinate {
	latitude: number
	longitude: number
}

/**
 * The resolution tier that produced a coordinate, mirroring mailwoman's geocoder (`address_point` >
 * `interpolated` > `admin`). Kept as a local plain union so this package stays decoupled from the
 * heavy geocoder runtime; a `GeocodeResult.resolution_tier` maps in directly.
 */
export type ResolutionTier = "address_point" | "interpolated" | "admin"

/** One resolved admin-hierarchy ancestor (most specific first), for spelling-invariant blocking. */
export interface HierarchyNode {
	tag: string
	value: string
	placeId?: string
}

/** A resolved geocode attached to an address record — the location signal the matcher scores on. */
export interface AddressGeocode {
	coordinate: GeoCoordinate
	tier: ResolutionTier
	/** Calibrated uncertainty radius in meters; `null` for the admin tier (no sub-locality estimate). */
	uncertaintyMeters: number | null
	/** Resolved admin hierarchy, locality → country (most specific first). */
	hierarchy?: HierarchyNode[]
	/** A delivery point, not a building — weakens location agreement even at a precise coordinate. */
	poBox?: boolean
	/** A multi-unit building where many records share one coordinate — weakens unit-level agreement. */
	multiUnit?: boolean
}

/**
 * The canonical address record. Composes the parser's components, the formatter's match key, an
 * optional human-readable form, and an optional resolved geocode. Plain data — no behavior.
 */
export interface PostalAddress {
	/** Parsed address components (`ComponentTag`-keyed). */
	components: ComponentDict
	/** Normalized, deterministic match key for blocking (from `@mailwoman/formatter`). */
	canonicalKey: string
	/** Optional human-readable single-line form, for display. */
	formatted?: string
	/** Resolved location, when geocoded. */
	geocode?: AddressGeocode
	/** The original free-text input, when known (provenance). */
	raw?: string
}

/** Options for {@linkcode toPostalAddress}. */
export interface ToPostalAddressOptions {
	/** Country (ISO-2 or name) for formatting. Defaults to the `country` component, else unset. */
	country?: string
	/** The original free-text input to retain as provenance. */
	raw?: string
	/** Also compute a human-readable `formatted` string. Default `true`. */
	format?: boolean
	/** Formatting options forwarded to the formatter. Defaults to single-line (`", "`). */
	formatOptions?: FormatAddressOptions
}

/**
 * Build a canonical {@linkcode PostalAddress} from parsed components: fills the match key (always)
 * and a human-readable form (unless disabled). Attach a geocode separately with
 * {@linkcode withGeocode} once the address is resolved.
 */
export function toPostalAddress(components: ComponentDict, opts: ToPostalAddressOptions = {}): PostalAddress {
	const country = opts.country ?? components.country ?? ""

	const record: PostalAddress = {
		components,
		canonicalKey: canonicalKey(components),
	}

	if (opts.raw !== undefined) record.raw = opts.raw

	if (opts.format !== false) {
		const formatted = formatAddress(components, country, opts.formatOptions ?? { separator: ", " })
		if (formatted) record.formatted = formatted
	}

	return record
}

/** Attach (or replace) a resolved geocode on an address record, returning a new record. */
export function withGeocode(record: PostalAddress, geocode: AddressGeocode): PostalAddress {
	return { ...record, geocode }
}
