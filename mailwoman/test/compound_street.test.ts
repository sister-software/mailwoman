// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { assert } from "mailwoman/sdk/test"
// street simple
assert(
	// ---
	"Foostraße",
	{
		// ---
		street: ["Foostraße"],
	}
)

// should not attach a second suffix
assert(
	// ---
	"Foostraße Rd",
	{
		// ---
		street: ["Foostraße"],
	}
)

assert(
	// ---
	"foo st and",
	{
		// ---
		street: ["foo st"],
	}
)

// address simple
assert(
	// ---
	"Foostraße 1",
	{
		// ---
		street: ["Foostraße"],
		house_number: ["1"],
	}
)
