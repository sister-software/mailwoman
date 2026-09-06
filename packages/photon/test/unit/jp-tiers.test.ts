/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The forward projection reads the JP tiers into Photon's city / state / district keys.
 */

import { photonForwardProperties, photonOSMTags } from "@mailwoman/photon/projection"
import { expect, test } from "vitest"

test("forward: a JP municipality is Photon's city, its prefecture the state, its district the district", () => {
	const props = photonForwardProperties({
		lat: 31.732839,
		lon: 131.083374,
		places: [
			{ tag: "district", name: "下長飯町" },
			{ tag: "municipality", name: "Miyakonojō" },
			{ tag: "prefecture", name: "Miyazaki" },
		],
	})

	expect(props.city).toBe("Miyakonojō")
	expect(props.state).toBe("Miyazaki")
	expect(props.district).toBe("下長飯町")
	expect(photonOSMTags("municipality")).toEqual({ osm_key: "place", osm_value: "city", type: "city" })
})
