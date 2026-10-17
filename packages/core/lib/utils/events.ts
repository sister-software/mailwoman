// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * A promise for the emitter's next event with the requested key —
 * `await once(child, "exit")` — rejecting on its `error`.
 */
export { once } from "node:events"

/**
 * An `EventTarget` whose events hold a typed `detail`, keyed by type in `EventMap`.
 *
 * Subclasses dispatch with `emit`, and listeners subscribe with `on`.
 * The base `addEventListener` still works for a caller that wants the `CustomEvent` itself.
 */
export class TypedEventTarget<EventMap extends object> extends EventTarget {
	/**
	 * Listen for one event type with its typed `detail`, answering a function that removes the listener.
	 */
	public on<K extends keyof EventMap & string>(type: K, listener: (detail: EventMap[K]) => void): () => void {
		const handler = (event: Event): void => listener((event as CustomEvent<EventMap[K]>).detail)

		this.addEventListener(type, handler)

		return () => this.removeEventListener(type, handler)
	}

	protected emit<K extends keyof EventMap & string>(type: K, detail: EventMap[K]): void {
		this.dispatchEvent(new CustomEvent(type, { detail }))
	}
}
