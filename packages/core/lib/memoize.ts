// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Memoized async loads built on `async-init`'s `Service`.
 *
 *   This module sits apart from `@mailwoman/core/promises` so that the dependency-free
 *   promise helpers keep `async-init` off every graph that imports them,
 *   among them the launcher path of `mailwoman --version`.
 */

import { Service } from "async-init"

/**
 * Memoizes a zero-argument async load as its in-flight promise, so concurrent callers share one call.
 *
 * A resolved value stays cached.
 * A rejection clears the memo, so the next call loads again rather than receiving
 * the same failure for the rest of the process or page.
 *
 * The memo is an `async-init` `Service`, the lazy handle `FamilyBundles` keeps one of per weights family.
 * The value sits in a box, because a `Service` holds objects only and calls the
 * lifecycle hooks of an object that declares them.
 */
export function memoizeResettable<T>(load: () => Promise<T>): () => Promise<T> {
	const service = new Service(async () => ({ value: await load() }))

	return () => service.resolve().then((box) => box.value)
}
