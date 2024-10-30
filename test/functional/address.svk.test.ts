/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { assert } from "mailwoman/sdk/test/utils"

assert("Divadelná 41/3, Trnava", [
	// ---
	{ street: "Divadelná" },
	{ housenumber: "41/3" },
	{ locality: "Trnava" },
])
