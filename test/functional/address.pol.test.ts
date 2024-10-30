/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { assert } from "mailwoman/sdk/test/utils"

assert("Szewska 6, Kraków", [{ street: "Szewska" }, { housenumber: "6" }, { locality: "Kraków" }])

assert("aleja Wojska Polskiego 178", [{ street: "aleja Wojska Polskiego" }, { housenumber: "178" }])

assert("aleja 29 listopada 11", [{ street: "aleja 29 listopada" }, { housenumber: "11" }])

assert("aleja Wojska 178", [{ street: "aleja Wojska" }, { housenumber: "178" }])

assert("Ulica Strzelecka 12, Nowy Sącz", [
	{ street: "Ulica Strzelecka" },
	{ housenumber: "12" },
	{ locality: "Nowy Sącz" },
])

assert("Żorska 11, 47-400", [{ street: "Żorska" }, { housenumber: "11" }, { postcode: "47-400" }])
