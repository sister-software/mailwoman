/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The address-source register — which jurisdictions exist, what research has resolved for each and what is known
 *   about every source's terms.
 *
 *   It is a backlog made checkable. Almost every source row is refused on several conditions at once, so ask
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

export {
	deriveEffectiveTrainingManifest,
	effectiveManifestDigest,
	epochMixtureAuditPath,
	ExclusionReason,
	provenanceDisagreement,
	provenanceRefusals,
	readConfigView,
} from "#source-register/effective-manifest"

export type {
	EffectiveConfigView,
	EffectiveSourceRecord,
	EffectiveTrainingManifest,
	EpochMixtureAudit,
} from "#source-register/effective-manifest"

export type * from "#source-register/types"
