// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { assert } from "mailwoman/test-kit"

assert(
	// ---
	"Korunní 810, Praha",
	{
		// ---
		street: ["Korunní"],
		house_number: ["810"],
		locality: ["Praha"],
	}
)

assert(
	// ---
	"Kájovská 68, Český Krumlov",
	{
		// ---
		street: ["Kájovská"],
		house_number: ["68"],
		locality: ["Český Krumlov"],
	}
)

assert(
	// ---
	"Beethovenova 641/9, Brno",
	{
		// ---
		street: ["Beethovenova"],
		house_number: ["641/9"],
		locality: ["Brno"],
	}
)
