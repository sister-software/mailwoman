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

	// A session registers both sets on its own scope, and the parent's process services win.
	registerProcessServices(generation, options)
	registerGenerationServices(generation, options, settings)

	const inherited = generation
		.graph()
		.filter((service) => service.inherited)
		.map((service) => service.token)

	expect(new Set(inherited)).toEqual(new Set([ClassifierService, ResolverModuleService]))
})

test("a service the parent scope substitutes is read by the services that need it, and its own chain never builds", async () => {
	await using parent = new ServiceRegistry()

	// The session's `candidate-db` needs the selection.
	// The selection takes a lease on the data root.
	parent.define(GenerationServices.candidateDB, { build: () => null })

	const generation = parent.createChild()
	const built: string[] = []

	generation.subscribe((event) => {
		if (event.type === "resolve-start") {
			built.push(event.token.description)
		}
	})

	registerProcessServices(generation, options)
	registerGenerationServices(generation, options, geocodeSessionSettings({ ...options, capitalTier: "off" }))

	// `capitals` declares a need on `candidate-db` and on no other service.
	await expect(generation.resolve(GenerationServices.capitals)).resolves.toBeNull()

	expect(built).toEqual(["capitals"])

	const states = new Map(generation.graph().map((service) => [service.token, service]))

	expect(states.get(GenerationServices.candidateDB)).toMatchObject({ inherited: true, state: "ready" })
	expect(states.get(GenerationServices.selection)).toMatchObject({ inherited: false, state: "idle" })
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
