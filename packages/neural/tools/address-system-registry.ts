/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The committed address-system registry: the id of every distinct component order in `@mailwoman/codex`'s layouts,
 *   and the system of each country in each script it has a layout for.
 *
 *   The address-system head has one output per id, so ids are append-only. `mailwoman dev generate address-systems`
 *   derives the registry from codex's layouts, and the label schema references the systems by these ids.
 *
 *   The file sits in the Python training package because training containers read it as package data from the
 *   volume's copy of `corpus-python/src`. It moves when the trainer does.
 */

import type { AddressScript } from "@mailwoman/codex/address/layouts"
import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { repoRootPath } from "@mailwoman/core/paths"

import type { LabelSchemaAddressSystems } from "#label-schema"

/**
 * The committed registry's path segments from the repository root.
 */
const REGISTRY_SEGMENTS = ["corpus-python", "src", "mailwoman_train", "address_systems.json"] as const

/**
 * The committed registry's path.
 */
export const ADDRESS_SYSTEMS_PATH = repoRootPath(...REGISTRY_SEGMENTS)

/**
 * One address system: its stable id and the component order that defines it.
 */
export interface AddressSystemEntry {
	id: number
	key: string
}

/**
 * The address-system registry as committed.
 */
export interface AddressSystemRegistry {
	$comment: string
	systems: AddressSystemEntry[]
	members: Array<{ country: string; script: AddressScript; system: number }>
}

/**
 * Reads the committed registry, or null when it has not been generated.
 */
export async function readAddressSystemRegistry(path = ADDRESS_SYSTEMS_PATH): Promise<AddressSystemRegistry | null> {
	return readLocalJSONFile<AddressSystemRegistry>(path).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return null

		throw error
	})
}

/**
 * The committed registry's systems, as the label schema references them.
 *
 * @throws When the registry has not been generated.
 */
export async function readAddressSystemsReference(): Promise<LabelSchemaAddressSystems> {
	const registry = await readAddressSystemRegistry()

	if (!registry) {
		throw new Error(`${ADDRESS_SYSTEMS_PATH} is missing; run \`mailwoman dev generate address-systems\``)
	}

	return { registry: REGISTRY_SEGMENTS.join("/"), systems: registry.systems }
}
