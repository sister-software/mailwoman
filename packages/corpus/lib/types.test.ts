// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, it } from "vitest"

import { AddressRole, addressRoleOf, type CanonicalRow } from "#types"

describe("corpus types", () => {
	it("addressRoleOf reads an absent role as the default and an explicit one verbatim", () => {
		const base: CanonicalRow = {
			raw: "PO Box 120, Austin, TX 78701",
			components: { po_box: "PO Box 120", locality: "Austin", region: "TX", postcode: "78701" },
			country: "US",
			source: "state-tx-notaries",
			source_id: "tx-1",
			license: "US-PD",
		}

		expect(base.addressRole).toBeUndefined()
		expect(addressRoleOf(base)).toBe(AddressRole.Premise)
		expect(addressRoleOf({ ...base, addressRole: AddressRole.Mailing })).toBe("mailing")
	})
})
