import { describe, expect, it } from "vitest"

import {
	type AddressSystemRegistry,
	deriveAddressSystemRegistry,
	readAddressSystemRegistry,
} from "#tools/dev-tools/codex/address/systems"

describe("address-system registry", () => {
	it("matches what codex's layouts derive, so the trainer and the runtime read the same ids", async () => {
		const committed = await readAddressSystemRegistry()

		expect(committed, "run `mailwoman dev generate address-systems`").not.toBeNull()
		expect(deriveAddressSystemRegistry(committed)).toEqual(committed)
	})

	it("keeps an id whose key has left the layouts and appends a new key after it", () => {
		const previous: AddressSystemRegistry = {
			$comment: "",
			systems: [{ id: 0, key: "retired order" }],
			members: [],
		}

		const derived = deriveAddressSystemRegistry(previous)

		expect(derived.systems[0]).toEqual({ id: 0, key: "retired order" })

		expect(derived.systems.slice(1).map((entry) => entry.id)).toEqual(
			derived.systems.slice(1).map((_, index) => index + 1)
		)

		expect(derived.members.every((member) => member.system > 0)).toBe(true)
	})

	it("gives every member a system whose key is registered", () => {
		const derived = deriveAddressSystemRegistry(null)
		const ids = new Set(derived.systems.map((entry) => entry.id))

		expect(derived.members.length).toBeGreaterThan(0)
		expect(derived.members.every((member) => ids.has(member.system))).toBe(true)
	})
})
