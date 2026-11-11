/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The official post-office lists `mailwoman gazetteer build post-offices` folds into `post-offices.db`.
 *
 *   One entry per source. A new country's source is written under `lib/<cc>/post-offices/` to the
 *   contract in `#post-offices/source` and added here.
 */

import type { PostOfficeSource } from "#post-offices/source"
import { usgsNationalMapPostOffices } from "#us/post-offices/usgs-national-map"

/**
 * Every registered post-office source, in the order the layer reads them.
 */
export const POST_OFFICE_SOURCES: readonly PostOfficeSource[] = [usgsNationalMapPostOffices]
