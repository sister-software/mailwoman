// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { assert } from "mailwoman/test-kit"
// https://github.com/openvenues/libpostal/issues/382
assert(
	// ---
	"3360 Grand Ave Oakland 94610-2737 CA",
	{
		house_number: ["3360"],
		street: ["Grand Ave"],
		locality: ["Oakland"],
		postcode: ["94610-2737"],
		region: ["CA"],
	}
)
