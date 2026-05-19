/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { assert } from "mailwoman/sdk/test"

assert(
	// ---
	"Zadarska 17, Pula",
	{
		// ---
		street: ["Zadarska"],
		house_number: ["17"],
		locality: ["Pula"],
	}
)
