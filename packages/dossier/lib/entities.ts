/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The physical objects: a parcel holds buildings, a building has entrances and units. Each is its own
 *   entity with its own identifiers, so a count or a permission attaches to the object it describes.
 */

import type { EntityID, EntityKind, ExternalID } from "#identifiers"

export interface EntityBase {
	id: EntityID
	kind: EntityKind
	externalIDs: readonly ExternalID[]
	label: string
}

export interface Parcel extends EntityBase {
	kind: "parcel"
}

export interface Building extends EntityBase {
	kind: "building"
}

export interface Entrance extends EntityBase {
	kind: "entrance"
}

export interface Unit extends EntityBase {
	kind: "unit"
}

export type Entity = Parcel | Building | Entrance | Unit

export function entityIndex(entities: readonly Entity[]): ReadonlyMap<EntityID, Entity> {
	const index = new Map<EntityID, Entity>()

	for (const entity of entities) {
		if (index.has(entity.id)) throw new Error(`entityIndex: duplicate entity id ${entity.id}`)

		index.set(entity.id, entity)
	}

	return index
}
