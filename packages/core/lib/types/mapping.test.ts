// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { expect, test } from "vitest"

import {
	componentTagToLegacyClassification,
	legacyClassificationToComponentTag,
	MAPPED_LEGACY_CLASSIFICATIONS,
} from "#types/mapping"

test("legacyClassificationToComponentTag: internal-only classifications map to null", () => {
	expect(legacyClassificationToComponentTag("alpha")).toBeNull()
	expect(legacyClassificationToComponentTag("numeric")).toBeNull()
	expect(legacyClassificationToComponentTag("stop_word")).toBeNull()
	expect(legacyClassificationToComponentTag("start_token")).toBeNull()
	expect(legacyClassificationToComponentTag("area")).toBeNull()
	expect(legacyClassificationToComponentTag("unknown")).toBeNull()
})

test("MAPPED_LEGACY_CLASSIFICATIONS: every listed tag round-trips to a non-null component", () => {
	for (const legacy of MAPPED_LEGACY_CLASSIFICATIONS) {
		expect(legacyClassificationToComponentTag(legacy)).not.toBeNull()
	}
})

test("componentTagToLegacyClassification: intersection_a inverts to the bare legacy 'intersection'", () => {
	// "first legacy entry wins" — intersection is the only source, so A inverts back to it.
	expect(componentTagToLegacyClassification("intersection_a")).toBe("intersection")
})

test("componentTagToLegacyClassification: intersection_b has no legacy source and maps to null", () => {
	expect(componentTagToLegacyClassification("intersection_b")).toBeNull()
})

test("componentTagToLegacyClassification: components with no legacy equivalent map to null", () => {
	expect(componentTagToLegacyClassification("prefecture")).toBeNull()
	expect(componentTagToLegacyClassification("po_box")).toBeNull()
	expect(componentTagToLegacyClassification("cedex")).toBeNull()
	expect(componentTagToLegacyClassification("subregion")).toBeNull()
})

test("round-trip: every mapped legacy tag survives legacy -> component -> legacy", () => {
	for (const legacy of MAPPED_LEGACY_CLASSIFICATIONS) {
		const component = legacyClassificationToComponentTag(legacy)!
		expect(componentTagToLegacyClassification(component)).toBe(legacy)
	}
})
