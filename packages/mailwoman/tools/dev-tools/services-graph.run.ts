// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Prints the services a geocode session composes and the services each one declares a need on.
 *
 *   It reads the registry's graph and builds no service, so it opens no database and loads no weights.
 *
 *   Usage: `node packages/mailwoman/tools/dev-tools/services-graph.run.ts [--locale en-US] [--json]`
 */

import { stringifyJSON } from "@mailwoman/core/json"
import { runIfScript } from "@mailwoman/core/scripting"
import { parseArguments } from "@mailwoman/core/scripting/arguments"

import { createGeocodeCommandOptions } from "#geocode/command-options"
import { describeGeocodeServices } from "#geocode/services"
import { geocodeSessionSettings } from "#geocode/session"

async function main(): Promise<void> {
	const { values: cli } = parseArguments({
		options: {
			locale: { type: "string" },
			json: { type: "boolean" },
		},
	})

	const options = createGeocodeCommandOptions(cli.locale ? { locale: cli.locale } : {})
	const services = await describeGeocodeServices(options, geocodeSessionSettings(options))

	if (cli.json) {
		console.log(
			stringifyJSON(
				services.map((service) => ({
					service: service.token.description,
					needs: service.needs.map((need) => ({
						key: need.key,
						service: need.token.description,
						optional: need.optional,
						registered: need.registered,
					})),
				}))
			)
		)

		return
	}

	for (const service of services) {
		const needs = service.needs.map((need) => {
			const marks = `${need.optional ? "?" : ""}${need.registered ? "" : " (unregistered)"}`

			return `${need.token.description}${marks}`
		})

		console.log(`${service.token.description}: ${needs.length ? needs.join(", ") : "needs no other service"}`)
	}
}

runIfScript(import.meta, main)
