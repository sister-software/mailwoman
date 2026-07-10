// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { assertClassification } from "mailwoman/sdk/test"

import { UnitDesignatorClassifier } from "./UnitDesignatorClassifier.ts"

const classifier = await new UnitDesignatorClassifier().ready()

assertClassification(classifier, "unit_designator", [
	["unit", ["en"]],
	["apt", ["en"]],
	["lot", ["en"]],
])
