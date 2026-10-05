/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Identifiers for the physical objects a dossier describes. An external identifier keeps the namespace
 *   of the authority that issued it, so two systems' numbers for one building never collide. An entity
 *   id is the application's own key, used for objects that no authority has numbered yet.
 *
 *   An external identifier cites the record that states it. A dossier admits the identifier by that
 *   record's availability date, as it admits every other record.
 */

import type { Evidence } from "#links"

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
	/**
	 * The record that states the identifier.
	 *
	 * A building's section shows the identifier once the dossier admits this record.
	 * An identifier without evidence is shown with the words `source unstated`,
	 * and `validateRecords` reports it as a warning.
	 */
	evidence?: Evidence
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
