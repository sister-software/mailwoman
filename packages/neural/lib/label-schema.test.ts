/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { workspacePath } from "@mailwoman/core/paths"
import { describe, expect, test } from "vitest"

import { buildLabelSchema } from "#label-schema"
import { STAGE3_BIO_LABELS } from "#labels"

const schema = buildLabelSchema({ registry: "test", systems: [{ id: 0, key: "postcode locality" }] })

describe("label schema", () => {
	test("the committed JSON's label sets and semantic tags equal the ones the constants build", async () => {
		const committed = await readLocalJSONFile<typeof schema>(workspacePath("neural", "data", "label-schema.v1.json"))

		expect({ ...committed, address_systems: null }).toEqual({ ...schema, address_systems: null })
	})

	test("an address-system id out of order is refused", () => {
		expect(() => buildLabelSchema({ registry: "test", systems: [{ id: 1, key: "a" }] })).toThrow(
			"address system 0 has id 1"
		)
	})

	test("every set keeps the stage-3 labels at their stage-3 indices", () => {
		const { label_sets } = schema

		for (const [name, set] of Object.entries(label_sets)) {
			expect(set.bio_labels.slice(0, STAGE3_BIO_LABELS.length), name).toEqual([...STAGE3_BIO_LABELS])
		}
	})

	test("the head widths match the trained models", () => {
		const widths = Object.fromEntries(
			Object.entries(schema.label_sets).map(([name, set]) => [name, set.bio_labels.length])
		)

		expect(widths).toEqual({ stage3: 33, "stage3-jp": 47, "stage3-cn": 35, "stage3-cjk": 49, stage4: 47 })
	})
})
