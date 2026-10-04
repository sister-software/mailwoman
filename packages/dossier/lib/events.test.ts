/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, test } from "vitest"

import {
	activeSubscriptionsAt,
	CommercialEventKind,
	eventsByKind,
	permissionCovers,
	signingAuthorityFor,
} from "#events"
import { EVENTS, HOUSE, NORTH, RELATIONS, SOUTH } from "#test/fixtures/example-house"

describe("separate customer events", () => {
	test("three households produce one event of each kind, and one active subscription", () => {
		expect(eventsByKind(EVENTS, CommercialEventKind.Inquiry).map((event) => event.id)).toEqual(["e1"])
		expect(eventsByKind(EVENTS, CommercialEventKind.Order).map((event) => event.id)).toEqual(["e2"])

		const active = activeSubscriptionsAt(EVENTS, HOUSE, "2022-06-30")

		expect(active.count).toBe(1)
		expect(active.events.map((event) => event.id)).toEqual(["e3"])
	})

	test("an undated active subscription is listed and never counted", () => {
		const active = activeSubscriptionsAt(EVENTS, HOUSE, "2022-06-30")

		expect(active.undated.map((event) => event.id)).toEqual(["e5"])
		expect(active.count).toBe(1)
	})

	test("a permission covers only the entrance in its scope", () => {
		expect(permissionCovers(EVENTS, NORTH).map((event) => event.id)).toEqual(["e4"])
		expect(permissionCovers(EVENTS, SOUTH)).toEqual([])
		expect(permissionCovers(EVENTS, HOUSE)).toEqual([])
	})
})

describe("construction and authority", () => {
	test("owner and manager roles are shown and signing authority stays unknown for both", () => {
		const authority = signingAuthorityFor(RELATIONS, HOUSE)

		expect(authority.known).toEqual([])
		expect(authority.unknown.map((relation) => relation.role)).toEqual(["owner", "manager"])
	})
})
