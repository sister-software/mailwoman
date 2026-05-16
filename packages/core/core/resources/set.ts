/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

/**
 * A set-like collection that maintains the order of its elements.
 */
export class Sequence<T extends WeakKey> extends Set<T> {
	#first: T | null
	#last: T | null

	/**
	 * The first node in the sequence.
	 */
	public get first(): T | null {
		return this.#first
	}

	/**
	 * The last node in the sequence.
	 */
	public get last(): T | null {
		return this.#last
	}

	public constructor(nodes: T[] = []) {
		super(nodes)

		this.#first = nodes[0] ?? null
		this.#last = nodes[nodes.length - 1] ?? null
	}

	/**
	 * Clear the sequence.
	 */
	public override clear() {
		super.clear()

		this.#first = null
		this.#last = null
	}

	/**
	 * Add a node to the sequence.
	 */
	public override add(...nodes: T[]): this {
		if (!nodes.length) return this

		for (const node of nodes) {
			if (typeof node === "undefined" || node === null) {
				throw new Error("Attempted to add an undefined or null node to a sequence.")
			}

			super.add(node)
		}

		if (!this.#first) {
			this.#first = nodes[0]!
		}

		this.#last = nodes[nodes.length - 1]!

		return this
	}

	/**
	 * Delete a node from the sequence.
	 */
	public override delete(node: T): boolean {
		if (typeof node === "undefined" || node === null) {
			throw new Error("Attempted to delete an undefined or null node from a sequence.")
		}

		const deleted = super.delete(node)

		if (!deleted) return false

		if (this.size === 0) {
			this.#first = null
			this.#last = null
		} else if (this.#first === node) {
			this.#first = this.values().next().value ?? null
		} else if (this.#last === node) {
			this.#last = Array.from(this).pop() ?? null
		}

		return true
	}

	/**
	 * Sort the sequence in place.
	 */
	public sort(callback: (a: T, b: T) => number) {
		const currentEntries = Array.from(this)

		currentEntries.sort(callback)

		this.clear()

		for (const node of currentEntries) {
			super.add(node)
		}

		this.#first = currentEntries[0] ?? null
		this.#last = currentEntries[currentEntries.length - 1] ?? null

		return this
	}

	/**
	 * Serialize the sequence to JSON.
	 */
	public override toJSON(): T[] {
		return Array.from(this)
	}

	/**
	 * Given a property key of the items in the sequence, return an iterator of the values of that
	 * property.
	 *
	 * This is useful when building nested maps of properties.
	 */
	public pluck<P extends keyof T>(property: P): IteratorObject<T[P], undefined, unknown> {
		return Iterator.from(this).map((node) => node[property])
	}

	public override toString() {
		return `Sequence(${this.size})`
	}

	public [Symbol.for("nodejs.util.inspect.custom")]() {
		const { first } = this

		if (!first) return "Sequence(0)"

		const constructorName = first.constructor.name

		return `${constructorName}Sequence(${this.size})`
	}
}

export function disposeOf<T extends Disposable | PropertyKey>(set: Pick<Set<T>, "clear" | typeof Symbol.iterator>) {
	for (const node of set) {
		if (!node || typeof node !== "object") continue

		node[Symbol.dispose]?.()
	}

	set.clear()
}

/**
 * A set that cleans up its elements when disposed.
 */
export class DisposableSet<T extends Disposable | PropertyKey> extends Set<T> implements Disposable {
	public [Symbol.dispose]() {
		for (const node of this) {
			if (!node || typeof node !== "object") continue

			node[Symbol.dispose]?.()
		}

		this.clear()
	}
}

/**
 * A set that asynchronously cleans up its elements when disposed.
 */
export class AsyncDisposableSet<T extends AsyncDisposable> extends Set<T> implements AsyncDisposable {
	public async [Symbol.asyncDispose]() {
		for (const node of this) {
			await node[Symbol.asyncDispose]?.()
		}

		this.clear()
	}
}
