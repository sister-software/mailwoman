// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { SUPPORT_PROMISES } from "@mailwoman/codex/support"
import { readReleaseConfig, shippingLocales } from "@mailwoman/core/release-config"
import { readScopeConfig } from "@mailwoman/core/scope-config"

import { type Diagnostic, DiagnosticSeverity, type RepoCheck } from "#repo-health/check"

const REGISTER = "scope.config.json"

/**
 * The inputs the scope comparison reads.
 */
export interface ShippingScope {
	/**
	 * Countries whose weights package ships, from `release.config.json`'s locales.
	 */
	shipping: ReadonlySet<string>
	/**
	 * Countries that hold a support promise.
	 */
	promised: ReadonlySet<string>
	/**
	 * `scope.config.json`'s `unpromisedShippingLocales`: country to reason.
	 */
	unpromised: Readonly<Record<string, string>>
}

/**
 * Compares the shipping countries with the promises and the stated reasons.
 *
 * Every shipping country holds a promise or a non-empty reason, and no reason outlives its cause.
 */
export function compareShippingScope(scope: ShippingScope): Diagnostic[] {
	const diagnostics: Diagnostic[] = []

	const error = (message: string): void => {
		diagnostics.push({ severity: DiagnosticSeverity.Error, message, file: REGISTER, line: null, details: null })
	}

	for (const country of [...scope.shipping].toSorted()) {
		if (scope.promised.has(country) || scope.unpromised[country]) continue

		error(
			`${country} ships a weights package, holds no support promise, and has no entry in unpromisedShippingLocales saying why`
		)
	}

	for (const [country, reason] of Object.entries(scope.unpromised)) {
		if (country.startsWith("$")) continue

		if (!reason) {
			error(
				`unpromisedShippingLocales lists ${country} with an empty reason; an entry is a debt with a reason someone can read, not an exemption`
			)
		} else if (scope.promised.has(country)) {
			error(`unpromisedShippingLocales still lists ${country}, which now holds a support promise; remove the entry`)
		} else if (!scope.shipping.has(country)) {
			error(`unpromisedShippingLocales lists ${country}, which no longer ships a weights package; remove the entry`)
		}
	}

	return diagnostics
}

/**
 * Checks that every shipping locale's country holds a support promise
 * or a stated reason in `scope.config.json`.
 */
export const localeScopeCheck: RepoCheck = {
	id: "locale-scope",
	description:
		"Every shipping locale's country holds a support promise or a stated reason in scope.config.json, and no reason is stale.",
	async run(context) {
		const scope = await readScopeConfig(context.repoRoot)

		const shipping = new Set(
			[...shippingLocales(await readReleaseConfig(context.repoRoot))]
				.map((locale) => locale.split("-")[1]?.toUpperCase())
				.filter((country): country is string => typeof country === "string")
		)

		return compareShippingScope({
			shipping,
			promised: new Set(SUPPORT_PROMISES.map((promise) => promise.country)),
			unpromised: scope.unpromisedShippingLocales ?? {},
		})
	},
}
