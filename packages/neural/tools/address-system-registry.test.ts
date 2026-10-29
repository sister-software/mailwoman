/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { workspacePath } from "@mailwoman/core/paths"
import { describe, expect, test } from "vitest"

import { buildLabelSchema } from "#label-schema"
import { readAddressSystemRegistry, readAddressSystemsReference } from "#tools/address-system-registry"

describe("address-system registry", () => {
	test("the committed label schema equals the one the constants and the registry build", async () => {
		const committed = await readLocalJSONFile(workspacePath("neural", "data", "label-schema.v1.json"))

		expect(committed).toEqual(buildLabelSchema(await readAddressSystemsReference()))
	})

	test("the schema references every system the registry assigns, by id in order, and every member names one", async () => {
		const registry = await readAddressSystemRegistry()

		expect(registry, "run `mailwoman dev generate address-systems`").not.toBeNull()

		const { systems } = await readAddressSystemsReference()
		const ids = systems.map((system) => system.id)

		expect(systems).toEqual(registry!.systems)
		expect(ids).toEqual(ids.map((_, index) => index))
		expect(registry!.members.every((member) => ids.includes(member.system))).toBe(true)
	})
})
