// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Matches a query to the support promise it falls inside, so a response can tell the caller
 *   whether Mailwoman guarantees the result and to what depth.
 *
 *   A query falls inside a promise when its country is the promise's country
 *   and its letters are written in the promise's input script, with letters of
 *   the promise's embedded name scripts also accepted.
 *   The repository check `support-promises` selects each promise's gauntlet evidence with the same test.
 */

import { type SupportPromise, supportPromisesFor, SUPPORT_DEPTHS } from "@mailwoman/codex/support"
import { isScriptCode, isWrittenInScript } from "@mailwoman/registry/iso15924/codes"
import type { BCP47 } from "@mailwoman/registry/types"
import { z } from "zod"

/**
 * The script subtag of a promise's input tag, or `null` when the tag states none.
 *
 * The `support-promises` check holds every input tag canonical with an explicit
 * script subtag, so this reads the subtag directly.
 * That keeps the 8,276-row language table out of a bundle that reads promises.
 */
export function promiseInputScript(promise: SupportPromise): BCP47.ScriptCode | null {
	return promise.input.split("-").find(isScriptCode) ?? null
}

/**
 * Whether `text` is written the way a promise covers: in its input script,
 * with its embedded name scripts accepted.
 */
export function textFitsPromise(text: string, promise: SupportPromise): boolean {
	const script = promiseInputScript(promise)

	if (!script) return false

	return isWrittenInScript(text, script, promise.embeddedNameScripts as readonly BCP47.ScriptCode[])
}

/**
 * The promise a query in `country` falls inside, or `null` when none covers it.
 *
 * A `null` country, such as a geocode that resolved no country, falls inside no promise.
 */
export function supportPromiseFor(text: string, country: string | null): SupportPromise | null {
	if (!country) return null

	return supportPromisesFor(country.toUpperCase()).find((promise) => textFitsPromise(text, promise)) ?? null
}

/**
 * The support promise a response reports: the country, input and depth Mailwoman guarantees for the query.
 */
export const SupportPromiseSchema = z
	.object({
		country: z.string(),
		input: z.string(),
		embeddedNameScripts: z.array(z.string()),
		depth: z.enum(SUPPORT_DEPTHS),
	})
	.meta({
		id: "SupportPromise",
		description:
			"The support promise the query falls inside. Inside `depth`, a wrong or missing result is a bug; below it, components may come back unresolved.",
	})

export type ReportedSupportPromise = z.infer<typeof SupportPromiseSchema>

/**
 * The support field a geocode response holds for a query in `country`: the matched promise, or `null`.
 */
export function reportSupport(text: string, country: string | null): ReportedSupportPromise | null {
	const promise = supportPromiseFor(text, country)

	if (!promise) return null

	return {
		country: promise.country,
		input: promise.input,
		embeddedNameScripts: [...promise.embeddedNameScripts],
		depth: promise.depth,
	}
}
