// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The geocode session a long-running process serves from, replaced
 *   when the data root moves to a new generation.
 *
 *   A request runs against the session that was current when it started.
 *   A replacement builds its session while the current one keeps serving, becomes current in one
 *   assignment, and disposes the previous session once the requests that started on it have finished.
 *
 *   A request therefore never reads a closed handle, and a replacement that fails
 *   to build leaves the current session serving.
 */

import type { GeocodeSession } from "#geocode/session"

interface Generation {
	session: GeocodeSession
	active: number
	idle: PromiseWithResolvers<void> | null
}

/**
 * The session a process serves from, with in-flight request counting and swap-then-drain replacement.
 */
export class GeocodeSessionSlot implements AsyncDisposable {
	#current: Generation
	#replacing: Promise<void> = Promise.resolve()

	constructor(session: GeocodeSession) {
		this.#current = { session, active: 0, idle: null }
	}

	/**
	 * The session new requests start on.
	 */
	get session(): GeocodeSession {
		return this.#current.session
	}

	/**
	 * Runs one request against the current session.
	 * That session stays open until the request settles.
	 */
	async run<T>(request: (session: GeocodeSession) => Promise<T>): Promise<T> {
		const generation = this.#current

		generation.active++

		try {
			return await request(generation.session)
		} finally {
			generation.active--

			if (generation.active === 0) {
				generation.idle?.resolve()
			}
		}
	}

	/**
	 * Builds a session with `build`, makes it current, and disposes the previous session
	 * after its requests finish.
	 *
	 * Replacements run one at a time in call order.
	 * When `build` throws, the current session keeps serving and the call rejects with that error.
	 */
	replace(build: () => Promise<GeocodeSession>): Promise<void> {
		const replacement = this.#replacing.then(() => this.#swap(build))

		// A failed replacement leaves the chain usable for the next one.
		this.#replacing = replacement.catch(() => {})

		return replacement
	}

	async #swap(build: () => Promise<GeocodeSession>): Promise<void> {
		const next: Generation = { session: await build(), active: 0, idle: null }
		const previous = this.#current

		this.#current = next

		await drained(previous)
		await previous.session[Symbol.asyncDispose]()
	}

	/**
	 * Waits for a replacement in progress and the current session's requests,
	 * then disposes the current session.
	 */
	async [Symbol.asyncDispose](): Promise<void> {
		await this.#replacing
		await drained(this.#current)
		await this.#current.session[Symbol.asyncDispose]()
	}
}

/**
 * Resolves once the generation has no request in flight.
 */
function drained(generation: Generation): Promise<void> {
	if (generation.active === 0) return Promise.resolve()

	generation.idle ??= Promise.withResolvers<void>()

	return generation.idle.promise
}
