// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Geocode sessions over one data generation, one per weights locale,
 *   chosen for each input by its country.
 *
 *   The sessions share one scope of data services: the selection lease, the resolver backend,
 *   the capital index, the region and national databases and the optional layers.
 *   Each locale adds a scope of its own with the classifier, the parse priors and the kind classifier,
 *   and a session for each default country and trace setting the caller asks for under that locale.
 *
 *   A bulk geocode (`#geocode/batch`) and the evaluation tools build their geocoders here,
 *   so a row geocoded in bulk is geocoded by the session `mailwoman geocode` builds.
 */

import { ServiceRegistry } from "async-init"

import type { LayerContribution } from "#geocode/layers/contributions"
import { type GeocodeSessionOptions, SessionOptionSource } from "#geocode/options"
import {
	createGeocodeSession,
	type GeocodeRequestOptions,
	type GeocodeRun,
	type GeocodeSession,
} from "#geocode/session"
import { registerDataServices, registerLocaleServices, registerProcessServices } from "#geocode/session/services"
import { NODE_LAYER_CONTRIBUTIONS } from "#services/entry/node"

/**
 * What selects the session an input is geocoded with.
 */
export interface GeocodeRoute {
	/**
	 * The input's country.
	 *
	 * It selects the input's weights locale through {@linkcode GeocodeRouting.localeByCountry}.
	 *
	 * An absent country, or one the table doesn't list, parses under the options' locale.
	 */
	country?: string | null

	/**
	 * The session's default country for this input: the resolver's caller scope, the parse's
	 * stated country and the venue-head country, as the session option of that name sets them.
	 */
	defaultCountry?: string

	/**
	 * Whether the session records a `GeocodeTrace` for the input.
	 */
	trace?: boolean
}

/**
 * How {@linkcode createRoutedGeocodeSessions} chooses and builds a locale's sessions.
 */
export interface GeocodeRouting {
	/**
	 * The weights locale each country's inputs parse under, keyed by ISO 3166-1 alpha-2 country.
	 */
	localeByCountry?: Readonly<Record<string, string>>

	/**
	 * Defines services on a locale's scope before the locale's own services register,
	 * so a caller may substitute one, such as a candidate classifier.
	 */
	prepareLocale?: (scope: ServiceRegistry, locale: string) => void

	/**
	 * Receives a routed locale whose session failed to build.
	 *
	 * That locale's inputs are geocoded under the options' locale from then on.
	 *
	 * @defaultValue a line on stderr
	 */
	onLocaleUnavailable?: (locale: string, error: unknown) => void

	/**
	 * The data layers the sessions compose.
	 *
	 * @defaultValue `NODE_LAYER_CONTRIBUTIONS` in `#services/entry/node`
	 */
	layers?: readonly LayerContribution[]
}

/**
 * The sessions of one set of options, routed by each input's country.
 *
 * Its async disposal closes every session and the data services they share.
 */
export interface RoutedGeocodeSessions extends AsyncDisposable {
	/**
	 * The session for a route, built on its first request.
	 */
	sessionFor(route?: GeocodeRoute): Promise<GeocodeSession>

	/**
	 * Geocodes `input` with the route's session.
	 */
	geocode(input: string, route?: GeocodeRoute, request?: GeocodeRequestOptions): Promise<GeocodeRun>

	/**
	 * The routed locales whose sessions failed to build, and whose inputs therefore
	 * parse under the options' locale.
	 */
	readonly unavailableLocales: ReadonlySet<string>
}

function reportUnavailableLocale(locale: string, error: unknown): void {
	console.error(
		// oxlint-disable-next-line mailwoman/prefer-spliterator -- An Error message rather than a data file.
		`  unavailable: the ${locale} weights, because ${(error instanceof Error ? error.message : String(error)).split("\n")[0]}; ` +
			`its inputs parse under the base locale`
	)
}

/**
 * Builds the shared data scope for `options` and returns the sessions routed over it.
 *
 * A locale's classifier and a route's session are built when an input first needs them.
 */
export function createRoutedGeocodeSessions(
	options: GeocodeSessionOptions,
	routing: GeocodeRouting = {}
): RoutedGeocodeSessions {
	const layers = routing.layers ?? NODE_LAYER_CONTRIBUTIONS
	const onLocaleUnavailable = routing.onLocaleUnavailable ?? reportUnavailableLocale
	const dataScope = new ServiceRegistry()

	registerDataServices(dataScope, options, layers)

	const localeScopes = new Map<string, ServiceRegistry>()
	const sessions = new Map<string, Promise<GeocodeSession>>()
	const unavailableLocales = new Set<string>()

	const localeScope = (locale: string): ServiceRegistry => {
		let scope = localeScopes.get(locale)

		if (!scope) {
			scope = dataScope.createChild()
			routing.prepareLocale?.(scope, locale)

			const localeOptions = { ...options, locale }

			registerProcessServices(scope, localeOptions)
			registerLocaleServices(scope, localeOptions)
			localeScopes.set(locale, scope)
		}

		return scope
	}

	const build = (locale: string, route: GeocodeRoute): Promise<GeocodeSession> =>
		createGeocodeSession(
			{
				...options,
				locale,
				localeSource: locale === options.locale ? options.localeSource : SessionOptionSource.Caller,
				...(route.defaultCountry ? { defaultCountry: route.defaultCountry } : {}),
				trace: route.trace ?? options.trace,
			},
			{ parent: localeScope(locale), layers }
		)

	const sessionFor = (route: GeocodeRoute = {}): Promise<GeocodeSession> => {
		const routed = route.country ? routing.localeByCountry?.[route.country.toUpperCase()] : undefined
		const locale = routed && !unavailableLocales.has(routed) ? routed : options.locale
		const key = [locale, route.defaultCountry ?? "", route.trace ?? options.trace].join("\n")
		let pending = sessions.get(key)

		if (!pending) {
			pending = build(locale, route).catch(async (error: unknown) => {
				sessions.delete(key)

				if (locale === options.locale) throw error

				// A routed locale that fails to build falls back to the options' locale for every later input.
				if (!unavailableLocales.has(locale)) {
					unavailableLocales.add(locale)
					onLocaleUnavailable(locale, error)
					await localeScopes.get(locale)?.[Symbol.asyncDispose]()
					localeScopes.delete(locale)
				}

				return sessionFor({ ...route, country: null })
			})

			sessions.set(key, pending)
		}

		return pending
	}

	return {
		sessionFor,
		geocode: async (input, route, request) => (await sessionFor(route)).geocode(input, request),
		unavailableLocales,
		// The data scope disposes its children first: each session's scope, then each locale's.
		[Symbol.asyncDispose]: () => dataScope[Symbol.asyncDispose](),
	}
}
