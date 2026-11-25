// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file Lists the scoped AWS identities this repository uses for the remote tile build. Each role holds the
 *   permissions one consumer needs. The tile-build role is an IAM user whose access key the lab host reads from
 *   the environment: it stages inputs in the inputs bucket, launches and stops build instances, sends them
 *   commands, and sets each instance's termination deadline. The tile-instance role is the IAM role a build
 *   instance assumes through its instance profile, so the instance reads the inputs bucket without a key on its
 *   disk. The tile-scheduler role is the IAM role EventBridge Scheduler assumes to terminate an instance at its
 *   deadline.
 *
 *   `mwops release mint-aws-credentials` creates both from the operator's own AWS session, the counterpart of
 *   `mint-cloudflare-tokens`. The session needs IAM write access. The identities it creates have none.
 */

/**
 * The region every build resource lives in.
 *
 * Overture's bucket is in the same region, so a build reads it without a transfer charge.
 */
export const AWS_BUILD_REGION = "us-west-2"

/**
 * The tag every build instance is launched with.
 *
 * The tile-build role may stop, terminate and command only an instance with it.
 */
export const AWS_BUILD_TAG = { key: "mailwoman:purpose", value: "tile-build" } as const

/**
 * The Parameter Store path that holds what a build instance reads at run time, such as the R2 upload keys.
 */
export const AWS_BUILD_PARAMETER_PATH = "/mailwoman/tile-build"

/**
 * The bucket that holds build inputs and export copies for an account.
 */
export function awsInputsBucket(accountID: string): string {
	return `mailwoman-basemaps-inputs-${accountID}`
}

/**
 * The identities this repository creates in AWS.
 */
export const AWSCredentialRoleID = {
	TileBuild: "tile-build",
	TileInstance: "tile-instance",
	TileScheduler: "tile-scheduler",
} as const

export type AWSCredentialRoleID = (typeof AWSCredentialRoleID)[keyof typeof AWSCredentialRoleID]

/**
 * One statement of an IAM policy document.
 */
interface AWSPolicyStatement {
	Sid: string
	Effect: "Allow"
	Action: string[]
	Resource: string[]
	Condition?: Record<string, Record<string, string>>
}

interface AWSPolicyDocument {
	Version: "2012-10-17"
	Statement: AWSPolicyStatement[]
}

interface AWSCredentialRoleBase {
	id: AWSCredentialRoleID
	/**
	 * The IAM user or role name.
	 *
	 * The mint operation finds an earlier identity by this name.
	 */
	name: string
	purpose: string
	/**
	 * The inline policy the identity holds, for an account.
	 */
	policy: (accountID: string) => AWSPolicyDocument
}

/**
 * An IAM user with one access key.
 * A consumer reads the key from two environment keys.
 */
export interface AWSUserRole extends AWSCredentialRoleBase {
	kind: "user"
	env: { accessKeyID: string; secretAccessKey: string }
}

/**
 * An IAM role that one AWS service assumes.
 */
export interface AWSServiceRole extends AWSCredentialRoleBase {
	kind: "service"
	/**
	 * The service principal the role's trust policy admits, such as `ec2.amazonaws.com`.
	 */
	service: string
	/**
	 * Whether the role has an instance profile of the same name, through which an EC2 instance assumes it.
	 */
	instanceProfile: boolean
	/**
	 * AWS-managed policies attached beside the inline policy.
	 */
	managedPolicies: readonly string[]
}

export type AWSCredentialRole = AWSUserRole | AWSServiceRole

/**
 * The role a build instance assumes through its instance profile.
 */
export const AWS_INSTANCE_ROLE_NAME = "mailwoman-tile-build-instance"

/**
 * The role EventBridge Scheduler assumes to terminate a build instance at its deadline.
 */
export const AWS_SCHEDULER_ROLE_NAME = "mailwoman-tile-build-scheduler"

/**
 * The prefix of each build instance's termination schedule.
 * The schedule's name ends in the instance id.
 */
export const AWS_SCHEDULE_PREFIX = "mailwoman-tile-build-"

/**
 * The statements both roles hold: list the inputs bucket, and read and write its objects.
 */
function inputsBucketStatements(accountID: string): AWSPolicyStatement[] {
	const bucket = `arn:aws:s3:::${awsInputsBucket(accountID)}`

	return [
		{ Sid: "InputsBucketList", Effect: "Allow", Action: ["s3:ListBucket", "s3:GetBucketLocation"], Resource: [bucket] },
		{
			Sid: "InputsBucketObjects",
			Effect: "Allow",
			Action: ["s3:GetObject", "s3:PutObject", "s3:AbortMultipartUpload", "s3:ListMultipartUploadParts"],
			Resource: [`${bucket}/*`],
		},
	]
}

function parameterResource(accountID: string): string {
	return `arn:aws:ssm:${AWS_BUILD_REGION}:${accountID}:parameter${AWS_BUILD_PARAMETER_PATH}/*`
}

const taggedForBuild = { StringEquals: { [`aws:ResourceTag/${AWS_BUILD_TAG.key}`]: AWS_BUILD_TAG.value } }
const inBuildRegion = { StringEquals: { "aws:RequestedRegion": AWS_BUILD_REGION } }

/**
 * Every role, in the order the report lists them.
 *
 * The mint creates the service roles before the user, because the user's policy
 * refers to each role by its ARN.
 */
export const AWS_CREDENTIAL_ROLES: readonly AWSCredentialRole[] = [
	{
		kind: "service",
		id: AWSCredentialRoleID.TileScheduler,
		name: AWS_SCHEDULER_ROLE_NAME,
		service: "scheduler.amazonaws.com",
		instanceProfile: false,
		purpose: "EventBridge Scheduler: terminates a build instance at the deadline its launch set.",
		managedPolicies: [],
		policy: (accountID) => ({
			Version: "2012-10-17",
			Statement: [
				{
					Sid: "BuildInstancesTerminate",
					Effect: "Allow",
					Action: ["ec2:TerminateInstances"],
					Resource: [`arn:aws:ec2:${AWS_BUILD_REGION}:${accountID}:instance/*`],
					Condition: taggedForBuild,
				},
			],
		}),
	},
	{
		kind: "service",
		id: AWSCredentialRoleID.TileInstance,
		name: AWS_INSTANCE_ROLE_NAME,
		service: "ec2.amazonaws.com",
		instanceProfile: true,
		purpose:
			"A build instance: reads and writes the inputs bucket, reads the build parameters, and answers Systems Manager commands.",
		managedPolicies: ["arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"],
		policy: (accountID) => ({
			Version: "2012-10-17",
			Statement: [
				...inputsBucketStatements(accountID),
				{
					Sid: "BuildParametersRead",
					Effect: "Allow",
					Action: ["ssm:GetParameter", "ssm:GetParametersByPath"],
					Resource: [parameterResource(accountID)],
				},
			],
		}),
	},
	{
		kind: "user",
		id: AWSCredentialRoleID.TileBuild,
		name: "mailwoman-tile-build",
		env: { accessKeyID: "AWS_TILE_BUILD_ACCESS_KEY_ID", secretAccessKey: "AWS_TILE_BUILD_SECRET_ACCESS_KEY" },
		purpose:
			"The lab host: stages inputs in the inputs bucket, launches, commands, stops and terminates build instances, sets each instance's termination deadline, and writes the build parameters.",
		policy: (accountID) => ({
			Version: "2012-10-17",
			Statement: [
				...inputsBucketStatements(accountID),
				{ Sid: "InstancesDescribe", Effect: "Allow", Action: ["ec2:Describe*"], Resource: ["*"] },
				{
					Sid: "InstancesLaunch",
					Effect: "Allow",
					Action: ["ec2:RunInstances", "ec2:CreateTags"],
					Resource: ["*"],
					Condition: inBuildRegion,
				},
				{
					Sid: "InstancesControl",
					Effect: "Allow",
					Action: ["ec2:StartInstances", "ec2:StopInstances", "ec2:TerminateInstances"],
					Resource: [`arn:aws:ec2:${AWS_BUILD_REGION}:${accountID}:instance/*`],
					Condition: taggedForBuild,
				},
				{
					// A running build writes its log to the bucket only on exit, so its console
					// output is the progress an operator can read while it runs.
					Sid: "BuildInstancesConsoleRead",
					Effect: "Allow",
					Action: ["ec2:GetConsoleOutput"],
					Resource: [`arn:aws:ec2:${AWS_BUILD_REGION}:${accountID}:instance/*`],
					Condition: taggedForBuild,
				},
				{
					Sid: "InstanceRolePass",
					Effect: "Allow",
					Action: ["iam:PassRole"],
					Resource: [`arn:aws:iam::${accountID}:role/${AWS_INSTANCE_ROLE_NAME}`],
					Condition: { StringEquals: { "iam:PassedToService": "ec2.amazonaws.com" } },
				},
				{
					Sid: "SchedulerRolePass",
					Effect: "Allow",
					Action: ["iam:PassRole"],
					Resource: [`arn:aws:iam::${accountID}:role/${AWS_SCHEDULER_ROLE_NAME}`],
					Condition: { StringEquals: { "iam:PassedToService": "scheduler.amazonaws.com" } },
				},
				{
					Sid: "DeadlineSchedules",
					Effect: "Allow",
					Action: ["scheduler:CreateSchedule", "scheduler:GetSchedule", "scheduler:DeleteSchedule"],
					Resource: [`arn:aws:scheduler:${AWS_BUILD_REGION}:${accountID}:schedule/default/${AWS_SCHEDULE_PREFIX}*`],
				},
				{
					Sid: "CommandsSendToBuildInstances",
					Effect: "Allow",
					Action: ["ssm:SendCommand"],
					Resource: [`arn:aws:ec2:${AWS_BUILD_REGION}:${accountID}:instance/*`],
					Condition: taggedForBuild,
				},
				{
					Sid: "CommandsSendShellDocument",
					Effect: "Allow",
					Action: ["ssm:SendCommand"],
					Resource: [`arn:aws:ssm:${AWS_BUILD_REGION}::document/AWS-RunShellScript`],
				},
				{
					Sid: "CommandsRead",
					Effect: "Allow",
					Action: [
						"ssm:GetCommandInvocation",
						"ssm:ListCommandInvocations",
						"ssm:ListCommands",
						"ssm:DescribeInstanceInformation",
					],
					Resource: ["*"],
				},
				{
					Sid: "MachineImageParametersRead",
					Effect: "Allow",
					Action: ["ssm:GetParameter", "ssm:GetParameters"],
					Resource: [`arn:aws:ssm:${AWS_BUILD_REGION}::parameter/aws/service/*`],
				},
				{
					Sid: "BuildParametersWrite",
					Effect: "Allow",
					Action: ["ssm:PutParameter", "ssm:GetParameter", "ssm:DeleteParameter"],
					Resource: [parameterResource(accountID)],
				},
			],
		}),
	},
]

export function findAWSCredentialRole(id: string): AWSCredentialRole {
	const role = AWS_CREDENTIAL_ROLES.find((candidate) => candidate.id === id)

	if (!role) {
		throw new Error(`no AWS credential role "${id}"; the roles are ${AWS_CREDENTIAL_ROLES.map((r) => r.id).join(", ")}`)
	}

	return role
}
