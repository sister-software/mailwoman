/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { assert } from "mailwoman/sdk/test/utils"

assert("Gamla Varmdovagen 6", [{ street: "Gamla Varmdovagen" }, { housenumber: "6" }])

assert("Gamla Varmdovägen 6", [{ street: "Gamla Varmdovägen" }, { housenumber: "6" }])

assert("Gamla Varmdo vägen 6", [{ street: "Gamla Varmdo vägen" }, { housenumber: "6" }])

assert("Ångermannagatan 80, Vällingby", [
	{ street: "Ångermannagatan" },
	{ housenumber: "80" } /*, { locality: 'Vällingby' } */,
])
