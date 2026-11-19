// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file Registration helpers for services held on an `async-init` `ServiceRegistry`.
 */

import { createToken, type ServiceRegistry, type ServiceToken } from "async-init"

/**
 * A service's value and the release its scope runs at disposal.
 *
 * A registry disposes only an instance that declares `Symbol.asyncDispose`,
 * and the repository's database handles declare the synchronous `Symbol.dispose`.
 * Every service is held in this shape, so the registry releases each one.
 */
export interface Held<T> extends AsyncDisposable {
	readonly value: T
}

/**
 * A registry token for a {@link Held} service value.
 */
export type ServiceKey<T> = ServiceToken<Held<T>>

/**
 * Creates the token for one service.
 */
export function serviceKey<T>(description: string): ServiceKey<T> {
	return createToken<Held<T>>(description)
}

/**
 * Wall-clock milliseconds of each service's own work, keyed by its token's description.
 *
 * The clock starts after the service's inputs resolve, so a figure excludes the wait for another service.
 * Services resolve in parallel, so the figures overlap and do not sum to a scope's total.
 */
export type ServiceTimings = Record<string, number>

/**
 * The inputs of a service that reads no other service.
 */
export const noInputs = async (): Promise<null> => null

/**
 * Registers one service: `inputs` awaits the services it reads, `build` constructs
 * the value, and `release` gives it back when the scope disposes.
 */
export function provide<I, T>(
	registry: ServiceRegistry,
	timings: ServiceTimings,
	key: ServiceKey<T>,
	inputs: () => Promise<I>,
	build: (inputs: I) => T | Promise<T>,
	release?: (value: T) => void | Promise<void>
): void {
	registry.register(key, async () => {
		const resolved = await inputs()
		const startedAt = performance.now()
		const value = await build(resolved)

		timings[key.description] = performance.now() - startedAt

		return {
			value,
			[Symbol.asyncDispose]: async () => {
				await release?.(value)
			},
		}
	})
}

/**
 * The value of a registered service, resolving it on first use.
 */
export async function need<T>(registry: ServiceRegistry, key: ServiceKey<T>): Promise<T> {
	return (await registry.get(key)).value
}
