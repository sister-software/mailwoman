/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { assert } from "mailwoman/sdk/test/utils"

assert("100, Mahalakshmi Rd, Ganesh Nagar, Kirti Nagar, New Sanghavi, Pimpri-Chinchwad, Maharashtra 411027", [
	{ housenumber: "100" },
	{ street: "Mahalakshmi Rd" },
	{ locality: "Pimpri-Chinchwad" },
	{ region: "Maharashtra" },
	{ postcode: "411027" },
])
