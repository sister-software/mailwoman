/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import FastGlob from "fast-glob"
import * as fs from "node:fs/promises"
import { PathBuilder } from "path-ts"
import { takeInParallel } from "../../collections.js"
import { prepareRepositoryDirectories, RepositorySource } from "../../git.js"
import {
	normalizePlacetypeDefinition,
	PlacetypeDefinition,
	PlacetypeDefinitionInit,
	PlacetypeRole,
	PlacetypeRoleOrder,
} from "./definition.js"

export const PLACETYPES_REPO_SOURCE = {
	url: "https://github.com/whosonfirst/whosonfirst-placetypes.git",
	owner: "whosonfirst",
	name: "whosonfirst-placetypes",
} as const satisfies RepositorySource

interface PlacetypeServiceInit {
	batchSize: number
	localRepoDirectory: PathBuilder
}

export class Placetype implements Disposable {
	public [Symbol.dispose]() {
		this.parentNames.clear()
		this.parents.clear()
		this.siblings.clear()
		this.children.clear()
	}

	//#region Static Caches

	/**
	 * A map of placetypes indexed by their Brooklyn Integers ID.
	 *
	 * Note that these IDs are not in any specific order. Avoid using them for sorting.
	 */
	static #byID = new Map<number, Placetype>()

	/**
	 * A map of placetypes indexed by their name.
	 */
	static #byName = new Map<string, Placetype>()

	/**
	 * A map of placetype children indexed by their parent's name.
	 */
	static #childrenOfParentName = new Map<string, Set<Placetype>>()

	/**
	 * A map of placetype children names indexed by their parent's name.
	 */
	static #childNamesOfParentName = new Map<string, Set<string>>()

	//#endregion

	//#region Static Methods

	static async prepare({ batchSize, localRepoDirectory }: PlacetypeServiceInit) {
		const { repoDirectory, exists } = await prepareRepositoryDirectories(PLACETYPES_REPO_SOURCE, localRepoDirectory)

		if (!exists) return

		const definitionPaths = FastGlob.stream(["*.json"], {
			cwd: repoDirectory("placetypes").toString(),
			absolute: true,
		})

		const batchIterator = takeInParallel(definitionPaths, batchSize, async (definitionPath) => {
			const definitionContent = await fs.readFile(definitionPath, "utf8")
			const definition: PlacetypeDefinition = JSON.parse(definitionContent)

			Placetype.register(definition)

			return definition
		})

		await Array.fromAsync(batchIterator)
	}

	/**
	 * Find a placetype by its name or ID.
	 */
	static find = (idOrName: number | string): Placetype | null => {
		if (typeof idOrName === "string") {
			return Placetype.#byName.get(idOrName) || null
		}

		return Placetype.#byID.get(idOrName) || null
	}

	/**
	 * Find a placetype by its name or ID.
	 *
	 * @throws {Error} If no placetype is found with the given name.
	 */
	static findOrThrow = (idOrName: number | string): Placetype => {
		const placetype = Placetype.find(idOrName)

		if (!placetype) {
			throw new Error(`No placetype found with id ${idOrName}`)
		}

		return placetype
	}

	/**
	 * Compare two placetypes, sorting less specific (i.e. bigger or higher) placetypes first.
	 *
	 * Note that the two placetype IDs have no affect on the comparison as they are not sequential,
	 * only unique.
	 */
	static comparatorAsc(a: Placetype, b: Placetype): number {
		if (a.siblings.has(b)) {
			return PlacetypeRoleOrder[a.role] - PlacetypeRoleOrder[b.role]
		}

		if (a.children.has(b)) return -1
		if (b.children.has(a)) return 1

		return 0
	}

	/**
	 * Compare two placetypes, sorting more specific (i.e. smaller or lower) placetypes first.
	 *
	 * Note that the two placetype IDs have no affect on the comparison as they are not sequential,
	 * only unique.
	 */
	static comparatorDesc(a: Placetype, b: Placetype): number {
		if (a.siblings.has(b)) {
			return PlacetypeRoleOrder[b.role] - PlacetypeRoleOrder[a.role]
		}

		if (a.children.has(b)) return 1
		if (b.children.has(a)) return -1

		return 0
	}

	//#endregion

	/**
	 * The source definition of this placetype.
	 */
	readonly #definition: PlacetypeDefinition

	//#region Properties

	/**
	 * The Brooklyn Integers ID of this placetype.
	 *
	 * This is effectively a unique identifier for the placetype, but any pattern of sequential
	 * integers is coincidental.
	 */
	public get id(): number {
		return this.#definition.id
	}

	/**
	 * The name of this placetype, e.g. "country", "city", "neighborhood"
	 */
	public get name(): string {
		return this.#definition.name
	}

	/**
	 * The role of this placetype, indicating its level of requirement to represent a full hierarchy.
	 *
	 * Some placetypes only exist to provide a supplementary role and are not required for a full
	 * hierarchy.
	 */
	public get role(): PlacetypeRole {
		return this.#definition.role
	}

	/**
	 * The parent names of this placetype, i.e. those that this Placetype is a child of.
	 *
	 * @example Continent is a parent of "country"
	 */
	public parentNames: Set<string>

	/**
	 * The parents of this Placetype, i.e. those with this Placetype as a child.
	 */
	public parents: Set<Placetype>

	/**
	 * Sibling Placetypes of this Placetype, i.e. those with the same parent.
	 *
	 * Note that this is **all** siblings across **all** parents.
	 */
	public siblings: Set<Placetype>

	/**
	 * Children of this Placetype, i.e. those with **this Placetype as a parent**.
	 */
	public children: Set<Placetype>

	//#endregion

	//#region Predicates

	/**
	 * Check if this placetype has a child matching the given name, ID, or Placetype instance.
	 */
	public hasChild(childLike: Placetype | string | number): boolean {
		const children = Placetype.#childrenOfParentName.get(this.name)

		if (!children) return false

		if (childLike instanceof Placetype) {
			return children.has(childLike)
		}

		const child = Placetype.findOrThrow(childLike)

		return children.has(child)
	}

	//#endregion

	//#region Lineage Methods

	/**
	 * Find the ancestors of this placetype, optionally filtered by role.
	 *
	 * An ancestor is a parent, grandparent, great-grandparent, etc. of this placetype.
	 */
	public findAncestors(roles?: Iterable<PlacetypeRole> | null): Placetype[] {
		const ancestorsContext = new Set<Placetype>()
		const roleFilters = roles ? new Set(roles) : null

		this.#collectAncestors(ancestorsContext, roleFilters)

		return Array.from(ancestorsContext).sort(Placetype.comparatorAsc)
	}

	#collectAncestors(ancestorsContext: Set<Placetype>, roleFilters?: Set<PlacetypeRole> | null): void {
		for (const parent of this.parents) {
			if (roleFilters && !roleFilters.has(parent.role)) continue

			ancestorsContext.add(parent)

			parent.#collectAncestors(ancestorsContext, roleFilters)
		}
	}

	/**
	 * Find the children of this placetype, optionally filtered by role.
	 *
	 * @see {@linkcode children} for children as a Set.
	 */
	public findChildren(roles?: Iterable<PlacetypeRole> | null): Placetype[] {
		const roleFilters = roles ? new Set(roles) : null
		const validChildren: Placetype[] = []

		for (const child of this.children) {
			if (roleFilters && !roleFilters.has(child.role)) continue

			validChildren.push(child)
		}

		return validChildren.sort(Placetype.comparatorAsc)
	}

	/**
	 * Find the parents of this placetype, optionally filtered by role.
	 *
	 * @see {@linkcode parents} for parents as a Set.
	 */
	public findParents(roles?: Iterable<PlacetypeRole> | null): Placetype[] {
		const roleFilters = roles ? new Set(roles) : null
		const validParents: Placetype[] = []

		for (const parent of this.parents) {
			if (roleFilters && !roleFilters.has(parent.role)) continue

			validParents.push(parent)
		}

		return validParents.sort(Placetype.comparatorDesc)
	}

	/**
	 * Find the siblings of this placetype, optionally filtered by role.
	 */
	public findSiblings(roles?: Iterable<PlacetypeRole> | null): Placetype[] {
		const roleFilters = roles ? new Set(roles) : null

		const validSiblings = Array.from(this.siblings)

		if (roleFilters) {
			return validSiblings.filter((sibling) => roleFilters.has(sibling.role))
		}

		return validSiblings.sort((a, b) => {
			return PlacetypeRoleOrder[a.role] - PlacetypeRoleOrder[b.role]
		})
	}

	/**
	 * Find the descendants of this placetype, optionally filtered by role.
	 *
	 * A descendant is a child, grandchild, great-grandchild, etc. of this placetype.
	 */
	public findDescendants(roles?: Iterable<PlacetypeRole> | null): Placetype[] {
		const descendantsContext = new Set<Placetype>()
		const roleFilters = roles ? new Set(roles) : null

		this.#collectDescendants(descendantsContext, roleFilters)

		return Array.from(descendantsContext).sort(Placetype.comparatorAsc)
	}

	#collectDescendants(descendantsContext: Set<Placetype>, roleFilters?: Set<PlacetypeRole> | null): void {
		for (const child of this.children) {
			if (roleFilters && !roleFilters.has(child.role)) continue

			descendantsContext.add(child)

			child.#collectDescendants(descendantsContext, roleFilters)
		}
	}

	//#endregion

	//#region Constructors

	/**
	 * Register a placetype specification, creating a new Placetype instance and indexing it by id.
	 */
	static register(initLike: PlacetypeDefinition | PlacetypeDefinitionInit): Placetype {
		const definition = normalizePlacetypeDefinition(initLike)
		const placetype = new Placetype(definition)

		return placetype
	}

	/**
	 * Create a new Placetype instance from a PlacetypeDefinition
	 *
	 * @see {@linkcode Placetype.register}
	 */
	protected constructor(definition: PlacetypeDefinition) {
		this.#definition = definition
		this.parentNames = new Set(definition.parent)
		this.parents = new Set()
		this.siblings = new Set()

		let children = Placetype.#childrenOfParentName.get(definition.name)

		if (!children) {
			children = new Set()
			Placetype.#childrenOfParentName.set(definition.name, children)
		}

		this.children = children

		// Constructor level indexes...
		Placetype.#byID.set(definition.id, this)
		Placetype.#byName.set(definition.name, this)

		// Next, we need to prepare the parent/child relationships...
		for (const parentName of definition.parent || []) {
			// Create the children set if it doesn't exist...
			let directSiblings = Placetype.#childrenOfParentName.get(parentName)

			if (!directSiblings) {
				directSiblings = new Set<Placetype>()

				Placetype.#childrenOfParentName.set(parentName, directSiblings)
			}

			// And add the placetype to the parent's children...
			directSiblings.add(this)

			// Once more, for the child names...
			let childNames = Placetype.#childNamesOfParentName.get(parentName)

			if (!childNames) {
				childNames = new Set<string>()

				Placetype.#childNamesOfParentName.set(parentName, childNames)
			}

			// Adding the name to the parent's child names...
			childNames.add(definition.name)

			// It's possible that this parent has already been registered...
			const parent = Placetype.find(parentName)

			if (parent) {
				this.parents.add(parent)

				const siblings = Placetype.#childrenOfParentName.get(parentName)

				for (const sibling of siblings || []) {
					if (sibling === this) continue

					this.siblings.add(sibling)
				}
			}
		}

		// Finally, there may be children who have registered before this placetype.
		// We need to adopt them into our parentage...
		const orphans = Placetype.#childrenOfParentName.get(definition.name)

		for (const child of orphans || []) {
			child.parents.add(this)
		}
	}

	//#endregion

	//#region Methods

	public toString() {
		const { name, id, role } = this.#definition
		return `Placetype[${name}][${id}][${role}]`
	}

	public [Symbol.for("nodejs.util.inspect.custom")]() {
		return this.toString()
	}
}
