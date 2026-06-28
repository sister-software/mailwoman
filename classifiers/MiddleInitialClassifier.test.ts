// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { assertClassification } from "mailwoman/sdk/test"

import { MiddleInitialClassifier } from "./MiddleInitialClassifier.js"

const classifier = new MiddleInitialClassifier()

assertClassification(classifier, "middle_initial", [
	["M", ["en"]],
	["M.", ["en"]],
])

assertClassification(classifier, "middle_initial", [
	["Mae", [], false],
	["122", [], false],
	["M,", [], false],
	["&", [], false],
	["Mr", [], false],
	["Esq", [], false],
])
