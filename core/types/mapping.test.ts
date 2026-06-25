/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { expect, test } from "vitest"
import {
	componentTagToLegacyClassification,
	legacyClassificationToComponentTag,
	MAPPED_LEGACY_CLASSIFICATIONS,
} from "./mapping.js"

test("legacyClassificationToComponentTag: maps the directly-named tags", () => {
	expect(legacyClassificationToComponentTag("country")).toBe("country")
	expect(legacyClassificationToComponentTag("region")).toBe("region")
	expect(legacyClassificationToComponentTag("locality")).toBe("locality")
	expect(legacyClassificationToComponentTag("postcode")).toBe("postcode")
	expect(legacyClassificationToComponentTag("house_number")).toBe("house_number")
	expect(legacyClassificationToComponentTag("street")).toBe("street")
	expect(legacyClassificationToComponentTag("street_prefix")).toBe("street_prefix")
	expect(legacyClassificationToComponentTag("street_suffix")).toBe("street_suffix")
	expect(legacyClassificationToComponentTag("unit")).toBe("unit")
	expect(legacyClassificationToComponentTag("venue")).toBe("venue")
})

test("legacyClassificationToComponentTag: 'dependency' renames to 'dependent_locality'", () => {
	expect(legacyClassificationToComponentTag("dependency")).toBe("dependent_locality")
})

test("legacyClassificationToComponentTag: bare 'intersection' coarsely maps to 'intersection_a'", () => {
	// intersection_b requires positional reasoning the legacy path can't supply; A is the default.
	expect(legacyClassificationToComponentTag("intersection")).toBe("intersection_a")
})

test("legacyClassificationToComponentTag: internal-only classifications map to null", () => {
	// alpha/numeric/stop_word/start_token etc. are not externally-visible components.
	expect(legacyClassificationToComponentTag("alpha")).toBeNull()
	expect(legacyClassificationToComponentTag("numeric")).toBeNull()
	expect(legacyClassificationToComponentTag("stop_word")).toBeNull()
	expect(legacyClassificationToComponentTag("start_token")).toBeNull()
	expect(legacyClassificationToComponentTag("area")).toBeNull()
	expect(legacyClassificationToComponentTag("unknown")).toBeNull()
})

test("MAPPED_LEGACY_CLASSIFICATIONS: lists exactly the legacy tags with a component mapping", () => {
	expect([...MAPPED_LEGACY_CLASSIFICATIONS].sort()).toEqual(
		[
			"country",
			"dependency",
			"house_number",
			"intersection",
			"locality",
			"postcode",
			"region",
			"street",
			"street_prefix",
			"street_suffix",
			"unit",
			"venue",
		].sort()
	)
})

test("MAPPED_LEGACY_CLASSIFICATIONS: every listed tag round-trips to a non-null component", () => {
	for (const legacy of MAPPED_LEGACY_CLASSIFICATIONS) {
		expect(legacyClassificationToComponentTag(legacy)).not.toBeNull()
	}
})

test("componentTagToLegacyClassification: inverts the direct tags", () => {
	expect(componentTagToLegacyClassification("country")).toBe("country")
	expect(componentTagToLegacyClassification("locality")).toBe("locality")
	expect(componentTagToLegacyClassification("postcode")).toBe("postcode")
	expect(componentTagToLegacyClassification("street")).toBe("street")
})

test("componentTagToLegacyClassification: 'dependent_locality' inverts to 'dependency'", () => {
	expect(componentTagToLegacyClassification("dependent_locality")).toBe("dependency")
})

test("componentTagToLegacyClassification: intersection_a inverts to the bare legacy 'intersection'", () => {
	// "first legacy entry wins" — intersection is the only source, so A inverts back to it.
	expect(componentTagToLegacyClassification("intersection_a")).toBe("intersection")
})

test("componentTagToLegacyClassification: intersection_b has no legacy source and maps to null", () => {
	// Nothing in the legacy table produces intersection_b, so the inverse is null.
	expect(componentTagToLegacyClassification("intersection_b")).toBeNull()
})

test("componentTagToLegacyClassification: components with no legacy equivalent map to null", () => {
	// JP-specific + venue-extra tags never appear in the rule path.
	expect(componentTagToLegacyClassification("prefecture")).toBeNull()
	expect(componentTagToLegacyClassification("po_box")).toBeNull()
	expect(componentTagToLegacyClassification("cedex")).toBeNull()
	expect(componentTagToLegacyClassification("subregion")).toBeNull()
})

test("round-trip: every mapped legacy tag survives legacy -> component -> legacy", () => {
	// intersection collapses to intersection_a then back to intersection, so the round-trip holds.
	for (const legacy of MAPPED_LEGACY_CLASSIFICATIONS) {
		const component = legacyClassificationToComponentTag(legacy)!
		expect(componentTagToLegacyClassification(component)).toBe(legacy)
	}
})
