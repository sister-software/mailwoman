/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The address-source register — which jurisdictions exist, what research has resolved for each, and what is known
 *   about every source's terms.
 *
 *   It is a backlog made checkable. All 389 source rows are ingest-eligible on zero counts today, so ask
 *   {@linkcode ingestEligibilityProblems} for the reasons rather than reading a status as permission.
 */

export {
	addressSourceRegisterPath,
	auditAddressSourceRegister,
	electedLicenseLabel,
	ingestEligibilityProblems,
	readAddressSourceRegister,
} from "#source-register/register"

export {
	BackboneState,
	JurisdictionResearchState,
	LicenseReviewState,
	REGISTER_SECTORS,
	ResearchPass,
	SourceGeometry,
	SourceStatus,
	UNRESOLVED_FIELDS,
} from "#source-register/types"

export type * from "#source-register/types"
