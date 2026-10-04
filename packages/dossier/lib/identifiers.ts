/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Identifiers for the physical objects a dossier describes. An external identifier keeps the namespace
 *   of the authority that issued it, so two systems' numbers for one building never collide. An entity
 *   id is the application's own key, used for objects that no authority has numbered yet.
 */

/**
 * The four physical objects a dossier describes, as the wire values an entity id's kind segment takes.
 */
export const EntityKind = {
	Parcel: "parcel",
	Building: "building",
	Entrance: "entrance",
	Unit: "unit",
} as const

export type EntityKind = (typeof EntityKind)[keyof typeof EntityKind]

export interface ExternalID {
	/**
	 * The issuing authority's namespace, such as `nyc:bin` or `os:uprn`.
	 */
	namespace: string
	value: string
}

/**
 * The application's key for an entity: `<kind>:<key>`.
 */
export type EntityID = string

export function entityID(kind: EntityKind, key: string): EntityID {
	if (key === "") throw new Error(`entityID: empty key for a ${kind}`)

	return `${kind}:${key}`
}

export function sameExternalID(a: ExternalID, b: ExternalID): boolean {
	return a.namespace === b.namespace && a.value === b.value
}
