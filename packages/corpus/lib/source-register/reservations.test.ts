// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { ReservationUse, SOURCE_RESERVATION_SCOPE, type SourceReservation } from "@mailwoman/license/reservation"
import { describe, expect, it } from "vitest"

import { indexCorpusSourceInputs, readCorpusSourceInputs } from "#source-register/corpus-inputs"
import { readAddressSourceRegister } from "#source-register/register"
import { auditReservationHistory, readCommittedTrainingManifests } from "#source-register/reservations"

const reservation: SourceReservation = {
	use: ReservationUse.Evaluation,
	scope: SOURCE_RESERVATION_SCOPE,
	since: "2026-11-22",
	because: "a confirmation pool",
	issue: 1,
}

const inputs = indexCorpusSourceInputs({
	sources: { "xx-adapter": { inputs: [{ registerSource: "xx-src-1", license: "lic", reads: "every row" }] } },
})

const registerWith = (recorded: SourceReservation) => ({ sources: [{ sourceID: "xx-src-1", reservation: recorded }] })

describe("auditReservationHistory", () => {
	it("refuses a lifted reservation whose retires omits a held-out dataset that froze rows from the source", () => {
		const lifted = { ...reservation, lifted: { at: "2026-12-01", because: "retired", issue: 2, retires: ["set-a"] } }

		const problems = auditReservationHistory(registerWith(lifted), {
			inputs,
			trainingManifests: [],
			heldoutDatasets: [
				{ datasetID: "set-a", corpusVersion: null, sources: ["xx-adapter"] },
				{ datasetID: "set-b", corpusVersion: null, sources: ["xx-adapter"] },
				{ datasetID: "set-c", corpusVersion: null, sources: ["another"] },
			],
		})

		expect(problems.filter((problem) => problem.includes("does not name"))).toEqual([
			'source "xx-src-1"\'s lifted reservation retires ["set-a"] and does not name set-b, which froze rows from it',
		])

		// set-c's source isn't mapped, so whether it froze rows from the source can't be read.
		expect(problems.join("\n")).toMatch(/set-c: another/u)
	})

	it("refuses a source-scope reservation on a source a training manifest read", () => {
		const problems = auditReservationHistory(registerWith(reservation), {
			inputs,
			trainingManifests: [{ corpusVersion: "v0.8.22", sources: [{ source: "xx-adapter" }] }],
			heldoutDatasets: [],
		})

		expect(problems).toEqual([
			'source "xx-src-1" is reserved at source scope, and training manifest(s) v0.8.22 read it, ' +
				"so its rows are no longer unseen by every model",
		])
	})

	it("finds no committed training manifest that read a source the register reserves", async () => {
		const register = await readAddressSourceRegister()
		const reserved = register.sources.filter((source) => source.reservation)

		// The audit judges a lift against the held-out datasets frozen under the data root.
		// This suite doesn't read them.
		expect(reserved.filter((source) => source.reservation!.lifted)).toEqual([])
		expect(reserved.length).toBeGreaterThan(0)

		expect(
			auditReservationHistory(register, {
				inputs: await readCorpusSourceInputs(register),
				trainingManifests: await readCommittedTrainingManifests(),
				heldoutDatasets: [],
			})
		).toEqual([])
	})
})
