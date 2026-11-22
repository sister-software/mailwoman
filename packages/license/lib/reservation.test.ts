// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, it } from "vitest"

import { auditSourceReservation, ReservationUse, SOURCE_RESERVATION_SCOPE, type SourceReservation } from "#reservation"

const reservation: SourceReservation = {
	use: ReservationUse.Evaluation,
	scope: SOURCE_RESERVATION_SCOPE,
	since: "2026-11-22",
	because: "a permanent confirmation pool",
	issue: 1,
}

describe("auditSourceReservation", () => {
	it("admits a complete reservation and a complete lift", () => {
		expect(auditSourceReservation("s", reservation)).toEqual([])

		expect(
			auditSourceReservation("s", {
				...reservation,
				lifted: { at: "2026-12-01", because: "retired", issue: 2, retires: [] },
			})
		).toEqual([])
	})

	it("refuses a lift that carries no retires list, no reason, or a date before the reservation began", () => {
		// A register read from JSON can omit `retires`, which the type requires.
		const lifted: Omit<NonNullable<SourceReservation["lifted"]>, "retires"> = {
			at: "2026-11-01",
			because: "",
			issue: 2,
		}

		const problems = auditSourceReservation("s", { ...reservation, lifted } as SourceReservation).join("\n")

		expect(problems).toMatch(/no `retires` list/u)
		expect(problems).toMatch(/no reason for the lift/u)
		expect(problems).toMatch(/before it began/u)
	})
})
