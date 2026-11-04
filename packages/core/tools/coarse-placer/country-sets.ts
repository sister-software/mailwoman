// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The country sets the coarse-placer dataset is drawn from. `build-dataset.ts` samples them. the
 *   outlier builders consult them to keep in-map countries out of the `other` pool.
 *
 *   Every set is read from {@linkcode COARSE_CLASSES}, the model's label map, through the source each class's rows
 *   are drawn from. A class added to the label map without a source fails to compile here.
 */

import { COARSE_CLASSES } from "#coarse-placer/featurize"

/**
 * A coarse-placer class other than `OTHER`, which is one country's code.
 */
type InMapClass = Exclude<(typeof COARSE_CLASSES)[number], "OTHER">

/**
 * Where a class's training rows come from.
 */
const CoarseRowSource = {
	/**
	 * The v0.5.0 corpus `train` extracts.
	 */
	Corpus: "corpus-v0.5.0",
	/**
	 * The Overture per-country addresses theme (the same source build-eu-eval-set.ts uses),
	 * for a class the v0.5.0 corpus holds zero rows of.
	 */
	Overture: "overture",
	/**
	 * The G-NAF corpus, which `build/dataset.ts` reads on its own glob.
	 */
	GNAF: "gnaf-corpus",
} as const

type CoarseRowSource = (typeof CoarseRowSource)[keyof typeof CoarseRowSource]

interface ClassSource {
	rows: CoarseRowSource
	/**
	 * The in-map dilution fix.
	 *
	 * The eu-eval sets and every Overture class are Overture format, so a corpus class that
	 * the eu-eval sets also hold gets an Overture sample beside its corpus rows.
	 * Each then owns its own format shape, the format stops being discriminative,
	 * and the model falls back to the linguistic n-grams.
	 * GB is left out because its Overture parquet is empty.
	 */
	overtureSupplement?: true
}

/**
 * The row source of each in-map class, a recorded fact of the dataset the shipped model was trained on.
 */
const CLASS_SOURCES: Readonly<Record<InMapClass, ClassSource>> = {
	US: { rows: CoarseRowSource.Corpus },
	FR: { rows: CoarseRowSource.Corpus },
	GB: { rows: CoarseRowSource.Corpus },
	CN: { rows: CoarseRowSource.Corpus },
	NL: { rows: CoarseRowSource.Corpus, overtureSupplement: true },
	IT: { rows: CoarseRowSource.Corpus, overtureSupplement: true },
	DE: { rows: CoarseRowSource.Corpus, overtureSupplement: true },
	JP: { rows: CoarseRowSource.Corpus },
	ES: { rows: CoarseRowSource.Corpus, overtureSupplement: true },
	KR: { rows: CoarseRowSource.Corpus },
	TW: { rows: CoarseRowSource.Corpus },
	AT: { rows: CoarseRowSource.Overture },
	BE: { rows: CoarseRowSource.Overture },
	CH: { rows: CoarseRowSource.Overture },
	CZ: { rows: CoarseRowSource.Overture },
	DK: { rows: CoarseRowSource.Overture },
	EE: { rows: CoarseRowSource.Overture },
	FI: { rows: CoarseRowSource.Overture },
	HR: { rows: CoarseRowSource.Overture },
	LT: { rows: CoarseRowSource.Overture },
	LU: { rows: CoarseRowSource.Overture },
	LV: { rows: CoarseRowSource.Overture },
	NO: { rows: CoarseRowSource.Overture },
	PL: { rows: CoarseRowSource.Overture },
	PT: { rows: CoarseRowSource.Overture },
	SI: { rows: CoarseRowSource.Overture },
	SK: { rows: CoarseRowSource.Overture },
	AU: { rows: CoarseRowSource.GNAF },
}

const IN_MAP_CLASSES: readonly InMapClass[] = COARSE_CLASSES.filter((c): c is InMapClass => c !== "OTHER")

/**
 * The in-map classes whose rows the v0.5.0 corpus `train` extracts supply, in label-map order.
 */
export const COUNTRIES: readonly InMapClass[] = IN_MAP_CLASSES.filter(
	(c) => CLASS_SOURCES[c].rows === CoarseRowSource.Corpus
)

/**
 * The EU expansion: the in-map classes drawn from Overture because the v0.5.0
 * corpus holds zero rows of them.
 *
 * These become first-class in-map countries so the soft country prior can pin them.
 */
export const NEW_EU: readonly InMapClass[] = IN_MAP_CLASSES.filter(
	(c) => CLASS_SOURCES[c].rows === CoarseRowSource.Overture
)

/**
 * The corpus classes that also get an Overture sample, the in-map dilution fix
 * described on `overtureSupplement`.
 *
 * The set is sorted by code, the order `build/dataset.ts` has always drawn them in.
 */
export const IN_MAP_EU: readonly InMapClass[] = IN_MAP_CLASSES.filter(
	(c) => CLASS_SOURCES[c].overtureSupplement
).toSorted()
