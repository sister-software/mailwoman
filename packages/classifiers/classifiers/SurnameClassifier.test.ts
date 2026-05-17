// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { assertClassification } from "../../../sdk/test/index.js"
import { SurnameClassifier } from "./SurnameClassifier.js"

const classifier = await new SurnameClassifier().ready()

assertClassification(classifier, "surname", [
	["Van der Beugel", ["all"]],
	["Johnson", ["all"]],
])
