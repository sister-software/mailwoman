// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, it } from "vitest"

import { OperationEffect } from "#scripting/operation"
import { applyStep, defineStateMachine, type StateCarrier } from "#state-machine"

type Door = "open" | "closed"

type DoorEvent = { kind: "push" } | { kind: "note"; text: string }

const door = defineStateMachine<Door, DoorEvent, { note: string }, { kind: "chime"; effect: OperationEffect }>({
	name: "door",
	states: ["open", "closed"],
	transition(state, event) {
		if (event.kind === "note") return { next: state, record: { note: event.text }, effects: [] }

		return state === "open"
			? { next: "closed", record: {}, effects: [{ kind: "chime", effect: OperationEffect.ExternalWrite }] }
			: { next: state, record: {}, effects: [] }
	},
})

/**
 * A carrier over one in-memory value that another writer can move between the read and the write.
 */
function memoryCarrier(initial: Door): StateCarrier<Door, { note: string }> & { state: Door; note: string | null } {
	const carrier = {
		state: initial,
		note: null as string | null,
		async compareAndSet(from: Door, to: Door, record: Readonly<Partial<{ note: string }>>) {
			if (carrier.state !== from) return false

			carrier.state = to

			if (record.note !== undefined) {
				carrier.note = record.note
			}

			return true
		},
	}

	return carrier
}

describe("applyStep", () => {
	it("writes the step, then runs its effects", async () => {
		const carrier = memoryCarrier("open")
		const ran: string[] = []

		const outcome = await applyStep(door, carrier, "open", { kind: "push" }, async (effect) => {
			ran.push(`${effect.kind} after ${carrier.state}`)
		})

		expect(outcome.status).toBe("applied")
		expect(ran).toEqual(["chime after closed"])
	})

	it("makes no write for a step that changes nothing", async () => {
		const carrier = memoryCarrier("closed")

		carrier.state = "open"

		// The step decided from `closed` keeps `closed` with an empty record and an empty effect list.
		await expect(applyStep(door, carrier, "closed", { kind: "push" })).resolves.toMatchObject({ status: "unchanged" })
		expect(carrier.state).toBe("open")
	})

	it("writes a recorded value even when the state stays", async () => {
		const carrier = memoryCarrier("closed")

		await expect(applyStep(door, carrier, "closed", { kind: "note", text: "painted" })).resolves.toMatchObject({
			status: "applied",
		})

		expect(carrier.note).toBe("painted")
	})

	it("refuses a step decided from a state the store has left, and runs no effect", async () => {
		const carrier = memoryCarrier("closed")
		const ran: string[] = []

		const outcome = await applyStep(door, carrier, "open", { kind: "push" }, async (effect) => {
			ran.push(effect.kind)
		})

		expect(outcome.status).toBe("conflict")
		expect(carrier.state).toBe("closed")
		expect(ran).toEqual([])
	})

	it("refuses to write a step with effects when no runner was given", async () => {
		await expect(applyStep(door, memoryCarrier("open"), "open", { kind: "push" })).rejects.toThrow("no runner")
	})
})
