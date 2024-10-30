/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { assert } from "mailwoman/sdk/test/utils"
// https://github.com/openvenues/libpostal/issues/382
assert("3360 Grand Ave Oakland 94610-2737 CA", [
	{ housenumber: "3360" },
	{ street: "Grand Ave" },
	{ locality: "Oakland" },
	{ postcode: "94610-2737" },
	{ region: "CA" },
])
