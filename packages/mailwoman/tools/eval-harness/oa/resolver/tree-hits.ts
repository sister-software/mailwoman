/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Read-only inspection of a resolved `AddressTree`. It reads a node's coordinate tiers and resolver-attributed
 *   places. It also records the tag presence tested by eval preconditions.
 */

import { walkNodes, type AddressNode, type AddressTree } from "@mailwoman/core/decoder"
import { mostSpecificResolved } from "@mailwoman/resolver"

/**
 * A resolver-attributed node contains the WOF place it landed on and that place's name and placetype.
 * It also contains that place's coordinate.
 *
 * `value` is the parsed span, kept beside the resolver's own `name`
 * because ranking a `postalcode` needs both.
 * A full unit shape the resolver answered with a coarser stem is area-grade, whatever the user typed.
 */
export interface Resolved {
	id: number
	name: string
	value: string
	placetype: string
	/**
	 * ISO-3166 alpha-2 the resolver placed the node in, when it stamped one.
	 *
	 * Read only for a `postalcode`, whose rank against the locality is per-address-system.
	 */
	country: string | null
	lat: number
	lon: number
}

/**
 * Pull the address-point hit (street-node metadata) out of a resolved tree, if any.
 */
export function findAddressPointHit(tree: AddressTree): { lat: number; lon: number } | null {
	for (const n of walkNodes(tree.roots)) {
		const ap = n.metadata?.address_point as { lat: number; lon: number } | undefined

		if (n.tag === "street" && ap) return ap
	}

	return null
}

/**
 * Pull the interpolated estimate (street-node metadata) out of a resolved tree, if any.
 */
export function findInterpolatedHit(tree: AddressTree): { lat: number; lon: number } | null {
	for (const n of walkNodes(tree.roots)) {
		const ip = n.metadata?.interpolated_point as { lat: number; lon: number } | undefined

		if (n.tag === "street" && ip) return ip
	}

	return null
}

/**
 * Collect all resolver-attributed nodes (we want per-placetype names rather than just the most-specific).
 */
export function collectResolved(tree: AddressTree): Resolved[] {
	const out: Resolved[] = []

	const visit = (n: AddressNode): void => {
		const meta = n.metadata as Record<string, unknown> | undefined

		if (n.placeID?.startsWith("wof:") && n.lat !== undefined && n.lon !== undefined) {
			const placetype = String(n.sourceID ?? "").split(":")[0] ?? ""
			const name = String(meta?.["resolver_name"] ?? n.value ?? "")

			out.push({
				id: Number(n.placeID.slice(4)),
				name,
				value: String(n.value ?? ""),
				placetype,
				country: null,
				lat: n.lat,
				lon: n.lon,
			})
		}

		// Multi-role completion: a dual-role region has extra roles (e.g. `locality`) as
		// interpretations on the same node rather than separate children.
		// Surface each resolved interpretation as its own Resolved so the eval finds the
		// completed locality (placetype/coord/name come from the interpretation).
		for (const interp of (n.interpretations ?? []) as ReadonlyArray<{
			tag: string
			placeID?: string
			sourceID?: string
			lat?: number
			lon?: number
			metadata?: Record<string, unknown>
		}>) {
			if (interp.placeID?.startsWith("wof:") && interp.lat !== undefined && interp.lon !== undefined) {
				const placetype = String(interp.sourceID ?? interp.tag).split(":")[0] ?? ""
				const name = String(interp.metadata?.["resolver_name"] ?? n.value ?? "")

				out.push({
					id: Number(interp.placeID.slice(4)),
					name,
					value: String(n.value ?? ""),
					placetype,
					country:
						typeof interp.metadata?.["resolver_country"] === "string"
							? (interp.metadata["resolver_country"] as string)
							: null,
					lat: interp.lat,
					lon: interp.lon,
				})
			}
		}

		for (const c of n.children) {
			visit(c)
		}
	}

	for (const r of tree.roots) {
		visit(r)
	}

	return out
}

/**
 * The deepest resolved place in the set, the one whose coordinate the eval grades.
 *
 * Delegates to `@mailwoman/resolver`'s ranking so the grade tracks what result assembly actually returns.
 * A flat `PLACETYPE_SPECIFICITY` sort promoted every resolved `postalcode` above the locality.
 * That reversed production's ranking order for one arm.
 */
export function mostSpecific(rs: Resolved[]): Resolved | null {
	return mostSpecificResolved(rs, (r) => ({
		placetype: r.placetype,
		value: r.value,
		resolverName: r.name,
		country: r.country ?? undefined,
	}))
}

/**
 * True when the tree contains both a street and a house number.
 *
 * The precondition the street-level tiers need before a miss can be read as a
 * database gap rather than a parse gap.
 */
export function hasStreetHouseNumber(tree: AddressTree | null): boolean {
	if (!tree) return false
	let street = false
	let hn = false

	const visit = (n: AddressNode): void => {
		if (n.tag === "street") {
			street = true
		}

		if (n.tag === "house_number") {
			hn = true
		}

		for (const c of n.children) {
			visit(c)
		}
	}

	for (const r of tree.roots) {
		visit(r)
	}

	return street && hn
}

/**
 * The first non-empty street, house-number and postcode values in the tree.
 *
 * The function also returns the interpolation tier's precondition triple and diagnostic text for a miss.
 */
export function findInterpolationSpans(tree: AddressTree): {
	street: string | null
	houseNumber: string | null
	postcode: string | null
} {
	let s: string | null = null
	let hn: string | null = null
	let pc: string | null = null

	for (const n of walkNodes(tree.roots)) {
		if (n.tag === "street" && !s && n.value.trim()) {
			s = n.value.trim()
		}

		if (n.tag === "house_number" && !hn && n.value.trim()) {
			hn = n.value.trim()
		}

		if (n.tag === "postcode" && !pc && n.value.trim()) {
			pc = n.value.trim()
		}
	}

	return { street: s, houseNumber: hn, postcode: pc }
}
