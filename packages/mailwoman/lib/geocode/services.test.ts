// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { ServiceRegistry } from "async-init"
import { expect, test } from "vitest"

import { createGeocodeCommandOptions } from "#geocode/command-options"
import {
	describeGeocodeServices,
	GenerationServices,
	registerGenerationServices,
	registerProcessServices,
	ResolverModuleService,
} from "#geocode/services"
import { geocodeSessionSettings } from "#geocode/session"
import { ClassifierService } from "#services/classifier"
import { ParsePriorArtifactsService, ParsePriorsService } from "#services/parse-priors"
import { recordServiceTimings, type ServiceTimings } from "#services/timings"

const options = createGeocodeCommandOptions()
const settings = geocodeSessionSettings(options)

test("every service a session composes declares its needs, and each need is registered", async () => {
	const services = await describeGeocodeServices(options, settings)

	expect(services.filter((service) => !service.declared).map((service) => service.token.description)).toEqual([])

	const unregistered = services.flatMap((service) =>
		service.needs
			.filter((need) => !need.registered)
			.map((need) => `${service.token.description} needs ${need.token.description}`)
	)

	expect(unregistered).toEqual([])
})

test("the graph holds every session token, and reading it builds no service", async () => {
	const services = await describeGeocodeServices(options, settings)
	const described = new Set(services.map((service) => service.token))

	const expected = [
		ClassifierService,
		ResolverModuleService,
		ParsePriorArtifactsService,
		ParsePriorsService,
		...Object.values(GenerationServices),
	]

	expect(expected.filter((token) => !described.has(token)).map((token) => token.description)).toEqual([])
	expect(new Set(services.map((service) => service.state))).toEqual(new Set(["idle"]))
})

test("a generation scope reads the process services from its parent, and shadows none of them", async () => {
	await using process = new ServiceRegistry()

	registerProcessServices(process, options)

	const generation = process.createChild()

	registerGenerationServices(generation, options, settings)

	const inherited = generation
		.graph()
		.filter((service) => service.inherited)
		.map((service) => service.token)

	expect(new Set(inherited)).toEqual(new Set([ClassifierService, ResolverModuleService]))
})

test("recordServiceTimings writes each built service's duration under its token's description", async () => {
	await using registry = new ServiceRegistry()

	const timings: ServiceTimings = {}

	recordServiceTimings(registry, timings)
	registry.define(GenerationServices.candidateDB, { build: () => null })

	registry.define(GenerationServices.capitals, {
		needs: { candidateDB: GenerationServices.candidateDB },
		build: () => null,
	})

	await registry.resolve(GenerationServices.capitals)

	expect(Object.keys(timings).toSorted()).toEqual(["candidate-db", "capitals"])
	expect(timings.capitals).toBeGreaterThanOrEqual(0)
})
