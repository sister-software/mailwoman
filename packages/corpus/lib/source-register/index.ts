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
	applyLicenseDecisions,
	auditAddressSourceRegister,
	electedLicenseLabel,
	INGEST_OPERATIONS,
	ingestEligibilityProblems,
	MODEL_RELEASE_OPERATIONS,
	permissionFor,
	readAddressSourceRegister,
	registerContentDigest,
} from "#source-register/register"

export {
	BackboneState,
	JurisdictionResearchState,
	LicenseReviewState,
	OperationPermission,
	PermissionBasis,
	PersonalDataReading,
	REGISTER_SECTORS,
	ResearchPass,
	SourceGeometry,
	SourceOperation,
	SourceStatus,
	UNRESOLVED_FIELDS,
} from "#source-register/types"

export {
	auditTrainingManifest,
	freezeTrainingManifest,
	sourcesNotPermitting,
	trainingManifestDigest,
} from "#source-register/training-manifest"

export type { TrainingManifest, TrainingSourceRecord } from "#source-register/training-manifest"

export type * from "#source-register/types"
