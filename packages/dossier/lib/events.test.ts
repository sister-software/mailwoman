/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, test } from "vitest"

import {
	activeSubscriptionsAt,
	type CommercialEvent,
	CommercialEventKind,
	eventsByKind,
	type OrganizationRelation,
	OrganizationRole,
	permissionCovers,
	signingAuthorityFor,
} from "#events"
import { HOUSE, NORTH, SOUTH } from "#test/fixtures/example-house"

const EVENTS: CommercialEvent[] = [
	{
		id: "e1",
		kind: CommercialEventKind.Inquiry,
		parties: [{ name: "Household A", role: "resident" }],
		scope: [HOUSE],
		date: "2022-05-01",
		evidence: { source: "manager-2023" },
	},
	{
		id: "e2",
		kind: CommercialEventKind.Order,
		parties: [{ name: "Household B", role: "resident" }],
		scope: [HOUSE],
		date: "2022-05-02",
		evidence: { source: "manager-2023" },
	},
	{
		id: "e3",
		kind: CommercialEventKind.ActiveSubscription,
		parties: [{ name: "Household C", role: "resident" }],
		scope: [HOUSE],
		date: "2022-05-03",
		evidence: { source: "manager-2023" },
	},
	{
		id: "e4",
		kind: CommercialEventKind.LandlordPermission,
		parties: [{ name: "Example Management Co", role: "manager" }],
		scope: [NORTH],
		date: "2022-05-10",
		evidence: { source: "manager-2023" },
	},
	{
		id: "e5",
		kind: CommercialEventKind.ActiveSubscription,
		parties: [{ name: "Household D", role: "resident" }],
		scope: [HOUSE],
		evidence: { source: "undated-listing" },
	},
]

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
	const relations: OrganizationRelation[] = [
		{
			organization: "Example Holdings LLC",
			role: OrganizationRole.Owner,
			subject: HOUSE,
			signingAuthority: "unknown",
			evidence: { source: "permit-2021" },
		},
		{
			organization: "Example Management Co",
			role: OrganizationRole.Manager,
			subject: HOUSE,
			signingAuthority: "unknown",
			evidence: { source: "manager-2023" },
		},
	]

	test("owner and manager roles are shown and signing authority stays unknown for both", () => {
		const authority = signingAuthorityFor(relations, HOUSE)

		expect(authority.known).toEqual([])
		expect(authority.unknown.map((relation) => relation.role)).toEqual(["owner", "manager"])
	})
})
