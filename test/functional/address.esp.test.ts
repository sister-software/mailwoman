/**
 * @copyright OpenISP, Inc.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { assert } from "mailwoman/sdk/test/utils"

assert("Carrer d'Aragó 155 08011 Barcelona", [
	{ street: "Carrer d'Aragó" },
	{ housenumber: "155" },
	{ postcode: "08011" },
	{ locality: "Barcelona" },
])
