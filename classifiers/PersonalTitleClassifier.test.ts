// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { ClassificationMatch } from "mailwoman/core"
import { assertClassification } from "mailwoman/sdk/test"
import { PersonalTitleClassifier } from "./PersonalTitleClassifier.js"

const classifier = await new PersonalTitleClassifier().ready()

const baseMatch = {
	classification: "personal_title",
	confidence: 1,
} as const satisfies Partial<ClassificationMatch>

assertClassification(classifier, "personal_title", [
	["Burgemeester", ["nl"]],
	["cdt", ["fr"]],
	["Général", ["fr"]],
	["gal", ["fr"]],
	["General", ["en"]],
	["l'Amiral", ["fr"]],
	["Saint", ["en"]],
	["st", ["en"]],
])
