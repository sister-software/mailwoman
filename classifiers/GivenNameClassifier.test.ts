// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { assertClassification } from "mailwoman/sdk/test"

import { GivenNameClassifier } from "./GivenNameClassifier.js"

const classifier = await new GivenNameClassifier().ready()

assertClassification(classifier, "given_name", [
	["Anderson Luís", ["all"]],
	["Peter", ["all"]],
])
