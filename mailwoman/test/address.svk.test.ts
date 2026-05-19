/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { assert } from "mailwoman/sdk/test"

assert(
	// ---
	"Divadelná 41/3, Trnava",
	{
		street: ["Divadelná"],
		house_number: ["41/3"],
		locality: ["Trnava"],
	}
)
