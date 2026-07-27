// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as imagebuilder from 'aws-cdk-lib/aws-imagebuilder';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';

export interface MacOSBaseImageStackProps extends cdk.StackProps {
  pascalCaseName: string;
  acronym: string;
  imagePipelinesTable: dynamodb.Table;
  amiTable: dynamodb.Table;
  logsBucket: s3.IBucket;
  buildSecurityGroup: ec2.SecurityGroup;
  encryptionKey?: kms.IKey;
}

// macOS versions to create pipelines for
// NOTE: Tahoe (macOS 26) is excluded because Amazon DCV does not currently support it
const MACOS_VERSIONS = [
  // { name: 'Tahoe', version: '26', ssmPath: '/aws/service/ec2-macos/tahoe/arm64_mac/latest/image_id' }, // DCV not supported
  { name: 'Sequoia', version: '15', ssmPath: '/aws/service/ec2-macos/sequoia/arm64_mac/latest/image_id' },
  { name: 'Sonoma', version: '14', ssmPath: '/aws/service/ec2-macos/sonoma/arm64_mac/latest/image_id' },
];

/**
 * Stack that creates system-managed EC2 Image Builder pipelines for macOS.
 * Creates one pipeline per macOS version (Tahoe, Sequoia, Sonoma).
 * Each pipeline produces a "DCV-Ready" AMI with:
 * - SIP (System Integrity Protection) disabled
 * - Screen Recording permission granted to DCV
 * - DCV Server installed and configured
 * - DCV Session Manager Agent installed
 * 
 * These AMIs are required as the base for all user macOS pipelines.
 */
export class MacOSBaseImageStack extends cdk.Stack {
  public readonly systemPipelineIds: string[];

  constructor(scope: Construct, id: string, props: MacOSBaseImageStackProps) {
    super(scope, id, {
      ...props,
      description: 'System pipelines for creating DCV-ready macOS base images'
    });

    this.systemPipelineIds = [];

    // ============================================
    // IAM ROLE FOR IMAGE BUILDER INSTANCES
    // ============================================

    const imageBuilderRole = new iam.Role(this, 'MacOSImageBuilderRole', {
      roleName: `${props.pascalCaseName}-MacOS-ImageBuilder-Role`,
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('EC2InstanceProfileForImageBuilder'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    });

    // Allow DCV license bucket access
    imageBuilderRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['s3:GetObject'],
      resources: [`arn:aws:s3:::dcv-license.${this.region}/*`],
    }));

    // Allow logs bucket access
    imageBuilderRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['s3:PutObject', 's3:GetBucketLocation'],
      resources: [props.logsBucket.bucketArn, `${props.logsBucket.bucketArn}/*`],
    }));

    // Allow KMS access for encrypted logs bucket
    if (props.encryptionKey) {
      imageBuilderRole.addToPolicy(new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['kms:GenerateDataKey', 'kms:Decrypt'],
        resources: [props.encryptionKey.keyArn],
      }));
    }

    // Allow reading the SIP admin password from Secrets Manager during Image Builder builds
    imageBuilderRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['secretsmanager:GetSecretValue'],
      resources: [`arn:aws:secretsmanager:${this.region}:${this.account}:secret:/${props.pascalCaseName}/ImageBuilder/SipAdminPassword-*`],
    }));

    const instanceProfile = new iam.InstanceProfile(this, 'MacOSImageBuilderProfile', {
      instanceProfileName: `${props.pascalCaseName}-MacOS-ImageBuilder-Profile`,
      role: imageBuilderRole,
    });

    // ============================================
    // SIP ADMIN PASSWORD (Secrets Manager)
    // ============================================
    // Password for ec2-user secure token bootstrap during macOS Image Builder builds.
    // Used by: (1) user data script at first boot, (2) SIP orchestrator Lambda for SIP disable API.
    // No special characters — they cause shell escaping issues in user data scripts.
    const sipAdminPasswordSecret = new cdk.aws_secretsmanager.Secret(this, 'SipAdminPasswordSecret', {
      secretName: `/${props.pascalCaseName}/ImageBuilder/SipAdminPassword`,
      description: 'Password for ec2-user secure token bootstrap during macOS Image Builder builds (SIP disable)',
      generateSecretString: {
        excludePunctuation: true,
        passwordLength: 24,
      },
    });

    // ============================================
    // EXECUTION ROLE FOR CUSTOM WORKFLOWS
    // ============================================
    // When using custom workflows, an execution role is required
    // This role allows Image Builder to perform workflow actions

    const workflowExecutionRole = new iam.Role(this, 'WorkflowExecutionRole', {
      roleName: `${props.pascalCaseName}-MacOS-Workflow-Execution-Role`,
      assumedBy: new iam.ServicePrincipal('imagebuilder.amazonaws.com'),
    });

    // Grant permissions needed for workflow execution (based on AWSServiceRoleForImageBuilder)
    workflowExecutionRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'ec2:RunInstances',
      ],
      resources: [
        `arn:aws:ec2:${this.region}::image/*`,
        `arn:aws:ec2:${this.region}::snapshot/*`,
        `arn:aws:ec2:${this.region}:${this.account}:subnet/*`,
        `arn:aws:ec2:${this.region}:${this.account}:network-interface/*`,
        `arn:aws:ec2:${this.region}:${this.account}:security-group/*`,
        `arn:aws:ec2:${this.region}:${this.account}:key-pair/*`,
        `arn:aws:ec2:${this.region}:${this.account}:launch-template/*`,
        // License configuration resource - required for launching with license-associated AMIs
        `arn:aws:license-manager:${this.region}:${this.account}:license-configuration:*`,
        // Host Resource Group - required for launching into the resource group
        `arn:aws:resource-groups:${this.region}:${this.account}:group/${props.pascalCaseName}-Mac-Host-Resource-Group`,
      ],
    }));

    workflowExecutionRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['ec2:RunInstances'],
      resources: [
        `arn:aws:ec2:${this.region}:${this.account}:volume/*`,
        `arn:aws:ec2:${this.region}:${this.account}:instance/*`,
      ],
      conditions: {
        StringEquals: {
          'aws:RequestTag/CreatedBy': 'EC2 Image Builder',
        },
      },
    }));

    workflowExecutionRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'ec2:CreateImage',
        'ec2:CreateTags',
        'ec2:DescribeImages',
        'ec2:DescribeImageAttribute',
        'ec2:DescribeInstanceStatus',
        'ec2:DescribeInstances',
        'ec2:DescribeInstanceTypeOfferings',
        'ec2:DescribeInstanceTypes',
        'ec2:DescribeSubnets',
        'ec2:DescribeTags',
        'ec2:DescribeSnapshots',
        'ec2:DescribeHosts',
        'ec2:RegisterImage',
        // Permission for distribution step to modify AMI attributes (launch permissions, etc.)
        'ec2:ModifyImageAttribute',
        // Permission for cross-region AMI distribution
        'ec2:CopyImage',
        // Permissions for Host Resource Group auto-allocation
        'ec2:AllocateHosts',
        'ec2:ModifyHosts',
      ],
      resources: ['*'],
    }));

    // Permissions for Host Resource Group operations
    workflowExecutionRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'resource-groups:ListGroupResources',
        'resource-groups:GetGroupConfiguration',
      ],
      resources: [`arn:aws:resource-groups:${this.region}:${this.account}:group/${props.pascalCaseName}-Mac-Host-Resource-Group`],
    }));

    // Permissions for License Manager - required to launch instances with license configurations
    workflowExecutionRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'license-manager:UpdateLicenseSpecificationsForResource',
        'license-manager:GetLicenseConfiguration',
      ],
      resources: ['*'],
    }));

    workflowExecutionRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'ec2:StopInstances',
        'ec2:StartInstances',
        'ec2:TerminateInstances',
      ],
      resources: ['*'],
      conditions: {
        StringEquals: {
          'ec2:ResourceTag/CreatedBy': 'EC2 Image Builder',
        },
      },
    }));

    workflowExecutionRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['iam:PassRole'],
      resources: [imageBuilderRole.roleArn],
      conditions: {
        StringEquals: {
          'iam:PassedToService': 'ec2.amazonaws.com',
        },
      },
    }));

    workflowExecutionRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'ssm:SendCommand',
        'ssm:ListCommands',
        'ssm:ListCommandInvocations',
        'ssm:DescribeInstanceInformation',
        'ssm:GetCommandInvocation',
      ],
      resources: ['*'],
    }));

    workflowExecutionRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'imagebuilder:GetComponent',
      ],
      resources: ['*'],
    }));

    workflowExecutionRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'logs:CreateLogStream',
        'logs:CreateLogGroup',
        'logs:PutLogEvents',
      ],
      resources: [`arn:aws:logs:${this.region}:${this.account}:log-group:/aws/imagebuilder/*`],
    }));

    // Permission to invoke the SIP Orchestrator Lambda for WaitForAction steps
    workflowExecutionRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['lambda:InvokeFunction'],
      resources: [`arn:aws:lambda:${this.region}:${this.account}:function:${props.acronym.toLowerCase()}-macos-sip-orchestrator`],
    }));

    // ============================================
    // SIP TASKS TABLE (for orchestrator/poller coordination)
    // ============================================
    // Stores pending SIP modification tasks so the poller can track them
    // and call RESUME/STOP on the Image Builder workflow when complete

    const sipTasksTable = new dynamodb.Table(this, 'SIPTasksTable', {
      tableName: `${props.acronym.toLowerCase()}-sip-tasks`,
      partitionKey: { name: 'taskId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      timeToLiveAttribute: 'ttl',
    });

    // ============================================
    // SIP ORCHESTRATOR LAMBDA
    // ============================================
    // Starts SIP disable tasks and stores them in DynamoDB for the poller

    const sipOrchestratorRole = new iam.Role(this, 'SIPOrchestratorRole', {
      roleName: `${props.pascalCaseName}-MacOS-SIP-Orchestrator-Role`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    sipOrchestratorRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'ec2:CreateMacSystemIntegrityProtectionModificationTask',
        'ec2:DescribeMacModificationTasks',
        'ec2:DescribeInstances',
      ],
      resources: ['*'],
    }));

    sipOrchestratorRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'imagebuilder:SendWorkflowStepAction',
        'imagebuilder:GetImage',
        'imagebuilder:GetWorkflowExecution',
        'imagebuilder:ListWorkflowStepExecutions',
        'imagebuilder:GetWorkflowStepExecution',
      ],
      resources: ['*'],
    }));

    sipOrchestratorRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['secretsmanager:GetSecretValue'],
      resources: [`arn:aws:secretsmanager:${this.region}:${this.account}:secret:/${props.pascalCaseName}/*`],
    }));

    sipOrchestratorRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['ssm:SendCommand', 'ssm:GetCommandInvocation', 'ssm:DescribeInstanceInformation'],
      resources: [
        `arn:aws:ssm:${this.region}:${this.account}:*`,
        `arn:aws:ec2:${this.region}:${this.account}:instance/*`,
        `arn:aws:ssm:${this.region}::document/AWS-RunShellScript`,
      ],
    }));

    props.imagePipelinesTable.grantReadWriteData(sipOrchestratorRole);
    props.amiTable.grantReadWriteData(sipOrchestratorRole);
    sipTasksTable.grantReadWriteData(sipOrchestratorRole);

    // Permission to enable the poller schedule rule
    sipOrchestratorRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['events:EnableRule'],
      resources: [`arn:aws:events:${this.region}:${this.account}:rule/${props.acronym.toLowerCase()}-macos-sip-poller-schedule`],
    }));

    const sipOrchestratorFunction = new lambda.Function(this, 'SIPOrchestratorFunction', {
      functionName: `${props.acronym.toLowerCase()}-macos-sip-orchestrator`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      role: sipOrchestratorRole,
      timeout: cdk.Duration.minutes(15),
      memorySize: 256,
      environment: {
        PASCAL_CASE_NAME: props.pascalCaseName,
        PIPELINES_TABLE_NAME: props.imagePipelinesTable.tableName,
        IMAGES_TABLE_NAME: props.amiTable.tableName,
        SIP_TASKS_TABLE_NAME: sipTasksTable.tableName,
        SIP_POLLER_RULE_NAME: `${props.acronym.toLowerCase()}-macos-sip-poller-schedule`,
        ADMIN_PASSWORD_SECRET_ARN: `arn:aws:secretsmanager:${this.region}:${this.account}:secret:/${props.pascalCaseName}/Workstation/StandaloneAdminPassword`, // pragma: allowlist secret
        SIP_ADMIN_PASSWORD_SECRET_ARN: sipAdminPasswordSecret.secretArn,
      },
      code: lambda.Code.fromAsset('lambda/macos-sip-orchestrator'),
    });

    // ============================================
    // SIP POLLER LAMBDA
    // ============================================
    // Runs on a schedule to check SIP task status and resume/stop workflows

    const sipPollerRole = new iam.Role(this, 'SIPPollerRole', {
      roleName: `${props.pascalCaseName}-MacOS-SIP-Poller-Role`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    sipPollerRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['ec2:DescribeMacModificationTasks'],
      resources: ['*'],
    }));

    sipPollerRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['imagebuilder:SendWorkflowStepAction'],
      resources: ['*'],
    }));

    // Permission to check SSM agent readiness after SIP disable reboot
    sipPollerRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['ssm:DescribeInstanceInformation'],
      resources: ['*'],
    }));

    props.imagePipelinesTable.grantReadWriteData(sipPollerRole);
    sipTasksTable.grantReadWriteData(sipPollerRole);

    // Permission to disable the poller schedule rule
    sipPollerRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['events:DisableRule'],
      resources: [`arn:aws:events:${this.region}:${this.account}:rule/${props.acronym.toLowerCase()}-macos-sip-poller-schedule`],
    }));

    const sipPollerFunction = new lambda.Function(this, 'SIPPollerFunction', {
      functionName: `${props.acronym.toLowerCase()}-macos-sip-poller`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      role: sipPollerRole,
      timeout: cdk.Duration.minutes(5),
      memorySize: 256,
      environment: {
        PIPELINES_TABLE_NAME: props.imagePipelinesTable.tableName,
        SIP_TASKS_TABLE_NAME: sipTasksTable.tableName,
        SIP_POLLER_RULE_NAME: `${props.acronym.toLowerCase()}-macos-sip-poller-schedule`,
      },
      code: lambda.Code.fromAsset('lambda/macos-sip-poller'),
    });

    // Schedule the poller to run every 2 minutes (starts DISABLED, orchestrator enables it)
    const sipPollerSchedule = new events.Rule(this, 'SIPPollerSchedule', {
      ruleName: `${props.acronym.toLowerCase()}-macos-sip-poller-schedule`,
      description: 'Runs SIP poller every 2 minutes to check task status (enabled on-demand)',
      schedule: events.Schedule.rate(cdk.Duration.minutes(2)),
      enabled: false, // Starts disabled - orchestrator enables when needed
    });

    sipPollerSchedule.addTarget(new targets.LambdaFunction(sipPollerFunction));

    // ============================================
    // EVENTBRIDGE RULE FOR WORKFLOW STEP WAITING
    // ============================================

    const workflowWaitingRule = new events.Rule(this, 'WorkflowStepWaitingRule', {
      ruleName: `${props.acronym.toLowerCase()}-macos-sip-workflow-waiting`,
      description: 'Triggers SIP orchestrator when macOS Image Builder workflow pauses',
      eventPattern: {
        source: ['aws.imagebuilder'],
        detailType: ['EC2 Image Builder Workflow Step Waiting'],
        detail: {
          'workflow-step-metadata': {
            action: ['WaitForAction'],
          },
        },
      },
    });

    workflowWaitingRule.addTarget(new targets.LambdaFunction(sipOrchestratorFunction));

    // ============================================
    // SHARED IMAGE BUILDER COMPONENTS
    // ============================================

    const grantTccPermissionComponent = new imagebuilder.CfnComponent(this, 'GrantTCCPermissionComponent', {
      name: `${props.pascalCaseName}-macOS-Grant-TCC-Permission`,
      platform: 'macOS',
      version: '1.0.0',
      description: 'Grants TCC permissions (Screen Recording, Accessibility, Remote Desktop) to DCV Server',
      data: `
name: GrantTCCPermission
description: Grant TCC permissions to DCV Server for remote desktop functionality
schemaVersion: 1.0
phases:
  - name: build
    steps:
      - name: GrantTCCPermissions
        action: ExecuteBash
        inputs:
          commands:
            - |
              echo "=== Granting TCC Permissions to DCV ==="
              SIP_STATUS=$(csrutil status)
              echo "SIP Status: $SIP_STATUS"
              if echo "$SIP_STATUS" | grep -q "enabled"; then
                echo "ERROR: SIP is still enabled. Cannot modify TCC database."
                exit 1
              fi
              echo "Modifying TCC database..."
              
              # Screen Capture permission for DCV Server (bundle ID)
              sudo sqlite3 "/Library/Application Support/com.apple.TCC/TCC.db" \\
                "INSERT OR REPLACE INTO access (service, client, client_type, auth_value, auth_reason, auth_version, indirect_object_identifier) \\
                 VALUES ('kTCCServiceScreenCapture', 'com.amazon.dcv.server', 0, 2, 4, 1, 'UNUSED');"
              
              # Screen Capture permission for dcvagent (correct path in DCV Server.app bundle)
              sudo sqlite3 "/Library/Application Support/com.apple.TCC/TCC.db" \\
                "INSERT OR REPLACE INTO access (service, client, client_type, auth_value, auth_reason, auth_version, indirect_object_identifier) \\
                 VALUES ('kTCCServiceScreenCapture', '/Applications/DCV Server.app/Contents/MacOS/dcvagent', 1, 2, 4, 1, 'UNUSED');"
              
              # Accessibility permission for DCV Server (bundle ID) - required for keyboard/mouse input injection
              sudo sqlite3 "/Library/Application Support/com.apple.TCC/TCC.db" \\
                "INSERT OR REPLACE INTO access (service, client, client_type, auth_value, auth_reason, auth_version, indirect_object_identifier) \\
                 VALUES ('kTCCServiceAccessibility', 'com.amazon.dcv.server', 0, 2, 4, 1, 'UNUSED');"
              
              # Accessibility permission for dcvagent (path-based) - required for input injection
              sudo sqlite3 "/Library/Application Support/com.apple.TCC/TCC.db" \\
                "INSERT OR REPLACE INTO access (service, client, client_type, auth_value, auth_reason, auth_version, indirect_object_identifier) \\
                 VALUES ('kTCCServiceAccessibility', '/Applications/DCV Server.app/Contents/MacOS/dcvagent', 1, 2, 4, 1, 'UNUSED');"
              
              # Remote Desktop permission for DCV Server - required for remote input control on macOS Tahoe+
              sudo sqlite3 "/Library/Application Support/com.apple.TCC/TCC.db" \\
                "INSERT OR REPLACE INTO access (service, client, client_type, auth_value, auth_reason, auth_version, indirect_object_identifier) \\
                 VALUES ('kTCCServiceRemoteDesktop', 'com.amazon.dcv.server', 0, 2, 4, 1, 'UNUSED');"
              
              # Remote Desktop permission for dcvagent (path-based)
              sudo sqlite3 "/Library/Application Support/com.apple.TCC/TCC.db" \\
                "INSERT OR REPLACE INTO access (service, client, client_type, auth_value, auth_reason, auth_version, indirect_object_identifier) \\
                 VALUES ('kTCCServiceRemoteDesktop', '/Applications/DCV Server.app/Contents/MacOS/dcvagent', 1, 2, 4, 1, 'UNUSED');"
              
              # PostEvent permission - may be required for input events on Tahoe
              sudo sqlite3 "/Library/Application Support/com.apple.TCC/TCC.db" \\
                "INSERT OR REPLACE INTO access (service, client, client_type, auth_value, auth_reason, auth_version, indirect_object_identifier) \\
                 VALUES ('kTCCServicePostEvent', 'com.amazon.dcv.server', 0, 2, 4, 1, 'UNUSED');"
              
              sudo sqlite3 "/Library/Application Support/com.apple.TCC/TCC.db" \\
                "INSERT OR REPLACE INTO access (service, client, client_type, auth_value, auth_reason, auth_version, indirect_object_identifier) \\
                 VALUES ('kTCCServicePostEvent', '/Applications/DCV Server.app/Contents/MacOS/dcvagent', 1, 2, 4, 1, 'UNUSED');"
              
              echo "TCC permissions granted successfully"
              echo "Verifying TCC entries for DCV:"
              sudo sqlite3 "/Library/Application Support/com.apple.TCC/TCC.db" \\
                "SELECT service, client, auth_value FROM access WHERE client LIKE '%dcv%' OR client LIKE '%DCV%';"
`,
    });

    // Install AWS CLI - required for workstation configuration scripts
    const installAwsCliComponent = new imagebuilder.CfnComponent(this, 'InstallAWSCLIComponent', {
      name: `${props.pascalCaseName}-macOS-Install-AWS-CLI`,
      platform: 'macOS',
      version: '1.0.0',
      description: 'Installs AWS CLI v2 on macOS',
      data: `
name: InstallAWSCLI
description: Install AWS CLI v2 for macOS
schemaVersion: 1.0
phases:
  - name: build
    steps:
      - name: InstallAWSCLI
        action: ExecuteBash
        inputs:
          commands:
            - |
              echo "=== Installing AWS CLI v2 ==="
              cd /tmp
              curl -s "https://awscli.amazonaws.com/AWSCLIV2.pkg" -o "AWSCLIV2.pkg"
              sudo installer -pkg AWSCLIV2.pkg -target /
              rm -f AWSCLIV2.pkg
              
              # Verify installation
              if /usr/local/bin/aws --version; then
                echo "AWS CLI installed successfully"
              else
                echo "ERROR: AWS CLI installation failed"
                exit 1
              fi
`,
    });

    const installDcvComponent = new imagebuilder.CfnComponent(this, 'InstallDCVComponent', {
      name: `${props.pascalCaseName}-macOS-Install-DCV`,
      platform: 'macOS',
      version: '1.0.0',
      description: 'Installs DCV Server and Session Manager Agent on macOS',
      data: `
name: InstallDCV
description: Install DCV Server and Session Manager Agent
schemaVersion: 1.0
phases:
  - name: build
    steps:
      - name: InstallDCVServer
        action: ExecuteBash
        inputs:
          commands:
            - |
              echo "=== Installing DCV Server ==="
              cd /tmp
              curl -O https://d1uj6qtbmh3dt5.cloudfront.net/nice-dcv-server-macos-arm64.dist.pkg
              sudo installer -pkg nice-dcv-server-macos-arm64.dist.pkg -target /
              echo "DCV Server installed"
      - name: InstallSessionManagerAgent
        action: ExecuteBash
        inputs:
          commands:
            - |
              echo "=== Installing DCV Session Manager Agent ==="
              cd /tmp
              curl -O https://d1uj6qtbmh3dt5.cloudfront.net/nice-dcv-session-manager-agent-macos-arm64.pkg
              sudo installer -pkg nice-dcv-session-manager-agent-macos-arm64.pkg -target /
              echo "Session Manager Agent installed"
      - name: ConfigureDCV
        action: ExecuteBash
        inputs:
          commands:
            - |
              echo "=== Configuring DCV Server ==="
              sudo mkdir -p /etc/dcv
              sudo tee /etc/dcv/dcv.conf > /dev/null << 'DCVEOF'
              [license]
              [log]
              level = "debug"
              [session-management]
              create-session = false
              [session-management/automatic-console-session]
              [display]
              enable-client-resize = true
              [connectivity]
              [security]
              administrators = ["dcvsmagent"]
              no-tls-strict = true
              os-auto-lock = false
              [clipboard]
              primary-selection-copy = true
              primary-selection-paste = true
              DCVEOF
              echo "DCV configuration created at /etc/dcv/dcv.conf"
`,
    });

    const configureAutoLoginComponent = new imagebuilder.CfnComponent(this, 'ConfigureAutoLoginComponent', {
      name: `${props.pascalCaseName}-macOS-Configure-AutoLogin`,
      platform: 'macOS',
      version: '1.0.0',
      description: 'Configures auto-login for ec2-user on macOS',
      data: `
name: ConfigureAutoLogin
description: Configure auto-login for ec2-user
schemaVersion: 1.0
phases:
  - name: build
    steps:
      - name: SetupAutoLogin
        action: ExecuteBash
        inputs:
          commands:
            - |
              echo "=== Configuring Auto-Login ==="
              sudo defaults write /Library/Preferences/com.apple.loginwindow autoLoginUser "ec2-user"
              sudo defaults write /Library/Preferences/com.apple.screensaver idleTime 0
              sudo pmset -a displaysleep 0
              sudo pmset -a sleep 0
              sudo /usr/libexec/ApplicationFirewall/socketfilterfw --setglobalstate off
              echo "Auto-login configured for ec2-user"
`,
    });

    // ============================================
    // MAC DEDICATED HOST RESOURCE GROUP (via Custom Resource)
    // ============================================
    // Using a Custom Resource Lambda to create the Host Resource Group
    // This approach:
    // 1. Controls IAM permissions explicitly via the Lambda role
    // 2. Makes deployments portable across accounts without IAM prereqs
    // 3. Handles the specific API calls needed for Host Resource Groups
    //
    // The Host Resource Group enables:
    // - Automatic host selection from available hosts in the group
    // - Auto-allocation of new hosts when none are available
    // - Works across multiple AZs where hosts exist

    const hostResourceGroupLambdaRole = new iam.Role(this, 'HostResourceGroupLambdaRole', {
      roleName: `${props.pascalCaseName}-MacOS-HRG-Lambda-Role`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    // Permissions for Resource Groups operations
    hostResourceGroupLambdaRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'resource-groups:CreateGroup',
        'resource-groups:DeleteGroup',
        'resource-groups:GetGroup',
        'resource-groups:UpdateGroup',
        'resource-groups:PutGroupConfiguration',
        'resource-groups:GetGroupConfiguration',
      ],
      resources: ['*'],
    }));

    // Permissions for EC2 Host Management (required for Host Resource Groups)
    hostResourceGroupLambdaRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'ec2:DescribeHosts',
        'ec2:AllocateHosts',
        'ec2:ModifyHosts',
      ],
      resources: ['*'],
    }));

    // Permissions for License Manager operations
    // Required to create license configurations for Host Resource Group launches
    hostResourceGroupLambdaRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'license-manager:CreateLicenseConfiguration',
        'license-manager:DeleteLicenseConfiguration',
        'license-manager:GetLicenseConfiguration',
        'license-manager:ListLicenseConfigurations',
        'license-manager:UpdateLicenseConfiguration',
        'license-manager:TagResource',
      ],
      resources: ['*'],
    }));

    // Permission to create/check the License Manager service-linked role
    // This role is required for Host Resource Groups with EC2 Host Management
    hostResourceGroupLambdaRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'iam:CreateServiceLinkedRole',
      ],
      resources: ['arn:aws:iam::*:role/aws-service-role/license-manager.amazonaws.com/*'],
      conditions: {
        StringEquals: {
          'iam:AWSServiceName': 'license-manager.amazonaws.com',
        },
      },
    }));

    hostResourceGroupLambdaRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'iam:GetRole',
      ],
      resources: [
        'arn:aws:iam::*:role/aws-service-role/license-manager.amazonaws.com/*',
        'arn:aws:iam::*:role/AWSServiceRoleForAWSLicenseManagerRole',
      ],
    }));

    const hostResourceGroupLambda = new lambda.Function(this, 'HostResourceGroupLambda', {
      functionName: `${props.acronym.toLowerCase()}-macos-host-resource-group`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      role: hostResourceGroupLambdaRole,
      timeout: cdk.Duration.minutes(5),
      memorySize: 256,
      code: lambda.Code.fromAsset('lambda/macos-host-resource-group'),
    });

    // Custom Resource Provider
    const hostResourceGroupProvider = new cr.Provider(this, 'HostResourceGroupProvider', {
      onEventHandler: hostResourceGroupLambda,
    });

    // Create the Host Resource Group via Custom Resource
    // Note: The Host Resource Group is created for future use and auto-allocation,
    // but we don't reference it directly in the infrastructure config because
    // that would require the parent AMI to have a license configuration associated.
    // Instead, we use tenancy: 'host' with auto-placement enabled on the hosts.
    const macHostResourceGroup = new cdk.CustomResource(this, 'MacHostResourceGroup', {
      serviceToken: hostResourceGroupProvider.serviceToken,
      properties: {
        GroupName: `${props.pascalCaseName}-Mac-Host-Resource-Group`,
        Description: 'Host Resource Group for macOS Dedicated Hosts with auto-allocation',
        AllowedHostFamilies: ['mac2', 'mac2-m2', 'mac2-m2pro'],
        AutoAllocateHost: 'true',
        AutoReleaseHost: 'false', // Keep hosts to avoid 24-hour minimum allocation charge
        LicenseConfigurationName: `${props.pascalCaseName}-Mac-License-Config`,
      },
    });

    // Get the License Configuration ARN from the Custom Resource output
    const licenseConfigArn = macHostResourceGroup.getAttString('LicenseConfigurationArn');

    // Regional hubs table name (by convention, to avoid cross-stack dependencies)
    const regionalHubsTableName = `${props.acronym.toLowerCase()}-regional-hubs`;

    // ============================================
    // DISTRIBUTION CONFIG CREATOR LAMBDA
    // ============================================
    // Creates/updates Image Builder distribution configs with dynamic satellite regions.
    // This allows distribution configs to be updated at deploy time based on active regional hubs.

    const createDistConfigRole = new iam.Role(this, 'CreateDistConfigRole', {
      roleName: `${props.pascalCaseName}-Create-Dist-Config-Role`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    createDistConfigRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['dynamodb:Scan'],
      resources: [`arn:aws:dynamodb:${this.region}:${this.account}:table/${regionalHubsTableName}`],
    }));

    createDistConfigRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'imagebuilder:CreateDistributionConfiguration',
        'imagebuilder:UpdateDistributionConfiguration',
        'imagebuilder:DeleteDistributionConfiguration',
        'imagebuilder:GetDistributionConfiguration',
        'imagebuilder:ListDistributionConfigurations',
        'imagebuilder:TagResource',
      ],
      resources: ['*'],
    }));

    // Grant KMS permissions to read encrypted DynamoDB table
    if (props.encryptionKey) {
      props.encryptionKey.grantDecrypt(createDistConfigRole);
    }

    const createDistConfigLambda = new lambda.Function(this, 'CreateDistConfigLambda', {
      functionName: `${props.acronym.toLowerCase()}-create-dist-config`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      role: createDistConfigRole,
      timeout: cdk.Duration.minutes(2),
      memorySize: 256,
      code: lambda.Code.fromAsset('lambda/create-distribution-config'),
    });

    const createDistConfigProvider = new cr.Provider(this, 'CreateDistConfigProvider', {
      onEventHandler: createDistConfigLambda,
    });

    // ============================================
    // SHARED INFRASTRUCTURE CONFIG
    // ============================================
    // We use dedicated host tenancy with auto-placement instead of Host Resource Group.
    // This allows us to use the raw AWS public macOS AMI as the parent image without
    // needing a license configuration. The license configuration is applied during
    // distribution to each region, avoiding cross-region license inheritance issues.
    //
    // IMPORTANT: Dedicated hosts must have auto-placement enabled for this to work.
    // The hosts in the Host Resource Group will still be used, but we don't reference
    // the group directly in the infrastructure config.

    // User data script to bootstrap secure token for ec2-user at first boot
    // This is REQUIRED for macOS Sequoia (15.x) SIP disable to work.
    // The secure token can ONLY be bootstrapped at first boot, not after the instance is running.
    // See: https://github.com/aws-samples/dcv-samples/tree/main/cdk/dcv-mac-image-automation
    //
    // The password is stored in Secrets Manager and retrieved at boot via AWS CLI.
    const sipAdminPasswordSecretArn = sipAdminPasswordSecret.secretArn;

    const userDataScript = `#!/bin/bash
# Bootstrap secure token for ec2-user at first boot
# This is required for SIP disable on macOS Sequoia
# Password is retrieved from Secrets Manager — never hardcoded in source

# Wait for network connectivity
for i in $(seq 1 30); do
  curl -s --max-time 2 http://169.254.169.254/latest/meta-data/instance-id > /dev/null && break
  sleep 2
done

# Retrieve password from Secrets Manager
REGION=$(curl -s http://169.254.169.254/latest/meta-data/placement/region)
EC2_USER_PASSWORD=$(/usr/local/bin/aws secretsmanager get-secret-value \\
  --secret-id "${sipAdminPasswordSecretArn}" \\
  --region "$REGION" \\
  --query 'SecretString' --output text 2>/dev/null)

if [ -z "$EC2_USER_PASSWORD" ]; then
  echo "ERROR: Failed to retrieve SIP admin password from Secrets Manager" | logger -t "secure-token-bootstrap"
  exit 1
fi

# Set password for ec2-user
/usr/bin/dscl . -passwd /Users/ec2-user "$EC2_USER_PASSWORD"

# Bootstrap secure token - MUST run as ec2-user using sudo -su
# Using same password for both -newPassword and -oldPassword bootstraps the token
sudo -su ec2-user sysadminctl -newPassword "$EC2_USER_PASSWORD" -oldPassword "$EC2_USER_PASSWORD"

# Log the result (not the password)
sysadminctl -secureTokenStatus ec2-user 2>&1 | logger -t "secure-token-bootstrap"
`;

    // Subnet ID is read from SSM to avoid cross-stack CloudFormation export references.
    // Cross-stack exports cause deployment failures when the MacBuildAvailabilityZone
    // parameter changes, because CloudFormation can't delete an export that another
    // stack still imports. Reading from SSM decouples the stacks entirely.
    const macBuildSubnetId = ssm.StringParameter.valueForStringParameter(
      this, `/${props.pascalCaseName}/Network/MacBuildSubnetId`
    );

    const infrastructureConfig = new imagebuilder.CfnInfrastructureConfiguration(this, 'MacOSInfraConfig', {
      name: `${props.pascalCaseName}-macOS-DCV-Ready-Infra`,
      instanceProfileName: instanceProfile.instanceProfileName!,
      // All Apple Silicon instance types - Image Builder uses first available
      // that has a dedicated host allocated in the build AZ
      instanceTypes: [
        'mac-m4.metal',       // M4
        'mac-m4pro.metal',    // M4 Pro
        'mac-m4max.metal',    // M4 Max
        'mac2-m2.metal',      // M2
        'mac2-m2pro.metal',   // M2 Pro
        'mac2.metal',         // M1
        'mac2-m1ultra.metal', // M1 Ultra
      ],
      securityGroupIds: [props.buildSecurityGroup.securityGroupId],
      subnetId: macBuildSubnetId,
      terminateInstanceOnFailure: true,
      instanceMetadataOptions: {
        httpTokens: 'required',
        httpPutResponseHopLimit: 2,
      },
      placement: {
        // Use dedicated host tenancy with auto-placement instead of Host Resource Group.
        // This avoids the need for a licensed parent AMI, which would cause cross-region
        // license inheritance issues when the output AMI is distributed to satellite regions.
        // Dedicated hosts must have auto-placement enabled (AutoPlacement: 'on').
        tenancy: 'host',
      },
      resourceTags: {
        'Purpose': 'macOS-DCV-Ready-Base-Image',
        'ManagedBy': props.pascalCaseName,
      },
      logging: {
        s3Logs: {
          s3BucketName: props.logsBucket.bucketName,
          s3KeyPrefix: 'imagebuilder-logs/macos-dcv-ready',
        },
      },
    });

    // Note: We no longer depend on the host resource group for the infrastructure config
    // since we're using auto-placement on dedicated hosts instead.

    // ============================================
    // SHARED WORKFLOW
    // ============================================

    const buildWorkflow = new imagebuilder.CfnWorkflow(this, 'MacOSBuildWorkflow', {
      name: `${props.pascalCaseName}-macOS-DCV-Ready-Build-Workflow`,
      type: 'BUILD',
      version: '1.8.0',
      description: 'Custom workflow that pauses for SIP disable before running components',
      data: `
name: macOS-DCV-Ready-Build-Workflow
description: Build workflow with SIP disable step
schemaVersion: 1.0
steps:
  - name: LaunchBuildInstance
    action: LaunchInstance
    onFailure: Abort
    inputs:
      waitFor: ssmAgent
  - name: WaitForSIPDisable
    action: WaitForAction
    onFailure: Abort
    inputs:
      lambdaFunctionName: ${props.acronym.toLowerCase()}-macos-sip-orchestrator
      payload: '{"instanceId": "{{ $.stepOutputs.LaunchBuildInstance.instanceId }}"}'
  - name: ExecuteBuildComponents
    action: ExecuteComponents
    onFailure: Abort
    inputs:
      instanceId.$: "$.stepOutputs.LaunchBuildInstance.instanceId"
  - name: CreateOutputImage
    action: CreateImage
    onFailure: Abort
    inputs:
      instanceId.$: "$.stepOutputs.LaunchBuildInstance.instanceId"
  - name: TerminateBuildInstance
    action: TerminateInstance
    inputs:
      instanceId.$: "$.stepOutputs.LaunchBuildInstance.instanceId"
outputs:
  - name: ImageId
    value: $.stepOutputs.CreateOutputImage.imageId
`,
    });

    // ============================================
    // CREATE PIPELINE FOR EACH MACOS VERSION
    // ============================================

    const pipelineRecords: { pipelineId: string; name: string; pipelineArn: string; macosVersion: string }[] = [];

    // Create a shared role for SSM parameter lookups to avoid using the CDK singleton Lambda
    // which can have permission issues with KMS-encrypted resources in the same stack
    const ssmLookupRole = new iam.Role(this, 'SSMLookupRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });
    ssmLookupRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['ssm:GetParameter'],
      resources: MACOS_VERSIONS.map(v => `arn:aws:ssm:${this.region}::parameter${v.ssmPath}`),
    }));
    // Grant KMS permissions in case the AwsCustomResource framework needs them
    if (props.encryptionKey) {
      props.encryptionKey.grantEncryptDecrypt(ssmLookupRole);
    }

    for (const macosVersion of MACOS_VERSIONS) {
      const versionId = macosVersion.name.toLowerCase();
      const pipelineId = `system-macos-${versionId}-dcv-ready`;
      this.systemPipelineIds.push(pipelineId);

      // Distribution config per version - created via custom resource to dynamically include satellite regions
      // The custom resource queries the regional hubs table at deploy time and builds the distribution config
      // with all active satellite regions. This ensures the config stays in sync with regional hubs.
      // Hash distribution config inputs - regional hubs changes will be detected by the Lambda
      // querying DynamoDB at runtime, but we still need to trigger on config changes
      const distConfigHash = Buffer.from([
        props.pascalCaseName,
        macosVersion.name,
        pipelineId,
        this.region,
        regionalHubsTableName,
      ].join('|')).toString('base64').substring(0, 32);

      const distConfig = new cdk.CustomResource(this, `MacOS${macosVersion.name}DistConfigV2`, {
        serviceToken: createDistConfigProvider.serviceToken,
        properties: {
          ConfigName: `${props.pascalCaseName}-macOS-${macosVersion.name}-DCV-Ready-Dist`,
          MacOSVersion: macosVersion.name,
          PascalCaseName: props.pascalCaseName,
          PipelineId: pipelineId,
          PrimaryRegion: this.region,
          LicenseConfigurationArn: licenseConfigArn,
          RegionalHubsTableName: regionalHubsTableName,
          ConfigHash: distConfigHash, // Only update when distribution config inputs change
        },
      });

      // Ensure distribution config is created after the host resource group (which creates the license config)
      distConfig.node.addDependency(macHostResourceGroup);

      // Use the AWS public macOS AMI directly as the parent image.
      // We no longer need a licensed copy because we're not using Host Resource Group
      // for the build infrastructure. The license configuration will be applied
      // during distribution to each region.
      //
      // Note: We use a custom resource to resolve the SSM parameter at deploy time
      // because CfnImageRecipe doesn't support SSM dynamic references for parentImage.
      const sourceAmiLookup = new cr.AwsCustomResource(this, `SourceAmiLookup${macosVersion.name}`, {
        onCreate: {
          service: 'SSM',
          action: 'getParameter',
          parameters: {
            Name: macosVersion.ssmPath,
          },
          physicalResourceId: cr.PhysicalResourceId.of(`source-ami-${macosVersion.name}`),
        },
        onUpdate: {
          service: 'SSM',
          action: 'getParameter',
          parameters: {
            Name: macosVersion.ssmPath,
          },
          physicalResourceId: cr.PhysicalResourceId.of(`source-ami-${macosVersion.name}`),
        },
        policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
          resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE,
        }),
        role: ssmLookupRole,
      });

      const sourceAmiId = sourceAmiLookup.getResponseField('Parameter.Value');

      // Recipe per version - uses the AWS public macOS AMI directly
      const imageRecipe = new imagebuilder.CfnImageRecipe(this, `MacOS${macosVersion.name}Recipe`, {
        name: `${props.pascalCaseName}-macOS-${macosVersion.name}-DCV-Ready-Recipe`,
        // IMPORTANT: Image Builder recipes are immutable. If you change ANYTHING that
        // affects this recipe's content (components, parent image, user data, block
        // device mappings), you MUST bump this version. CloudFormation replaces the
        // recipe on any content change, and recreating an existing name/version fails
        // with AlreadyExists, breaking the deploy.
        // 1.2.0: encode user data with Fn.base64 at deploy time so the Secrets Manager
        //        ARN token resolves (previously the literal '${Token[...]}' placeholder
        //        was baked in at synth time, breaking SIP bootstrap and causing recipe
        //        churn on every synth).
        version: '1.2.0',
        parentImage: sourceAmiId, // Use AWS public AMI directly (no license config)
        components: [
          { componentArn: grantTccPermissionComponent.attrArn },
          { componentArn: installAwsCliComponent.attrArn },
          { componentArn: installDcvComponent.attrArn },
          { componentArn: configureAutoLoginComponent.attrArn },
        ],
        blockDeviceMappings: [{
          deviceName: '/dev/sda1',
          ebs: { volumeSize: 200, volumeType: 'gp3', deleteOnTermination: true },
        }],
        // Bootstrap secure token for ec2-user at first boot - required for SIP disable on Sequoia
        additionalInstanceConfiguration: {
          // Encode at deploy time with Fn::Base64 so CDK tokens inside the script
          // (the Secrets Manager ARN) resolve to real values first. Synth-time
          // Buffer.from(...) encoding would freeze the unresolved token placeholder
          // text into the recipe.
          userDataOverride: cdk.Fn.base64(userDataScript),
        },
      });

      // Recipe depends on the source AMI lookup
      imageRecipe.node.addDependency(sourceAmiLookup);

      // Pipeline per version
      const imagePipeline = new imagebuilder.CfnImagePipeline(this, `MacOS${macosVersion.name}Pipeline`, {
        name: `${props.pascalCaseName}-macOS-${macosVersion.name}-DCV-Ready-Pipeline`,
        description: `System pipeline for creating DCV-ready macOS ${macosVersion.name} base images`,
        imageRecipeArn: imageRecipe.attrArn,
        infrastructureConfigurationArn: infrastructureConfig.attrArn,
        distributionConfigurationArn: distConfig.getAttString('DistributionConfigurationArn'),
        executionRole: workflowExecutionRole.roleArn,
        status: 'ENABLED',
        enhancedImageMetadataEnabled: true,
        workflows: [{ workflowArn: buildWorkflow.attrArn }],
      });

      pipelineRecords.push({
        pipelineId,
        name: `macOS ${macosVersion.name} DCV-Ready Base`,
        pipelineArn: imagePipeline.attrArn,
        macosVersion: macosVersion.name,
      });

      // SSM parameter for this version's DCV-Ready AMI
      new ssm.StringParameter(this, `DCVReadyAmi${macosVersion.name}Parameter`, {
        parameterName: `/${props.pascalCaseName}/macOS/${macosVersion.name}/DCVReadyBaseAmi`,
        stringValue: 'pending-first-build',
        description: `AMI ID of the latest DCV-ready macOS ${macosVersion.name} base image`,
      });
    }

    // ============================================
    // CUSTOM RESOURCE TO INSERT PIPELINE RECORDS
    // ============================================

    // Create a custom resource to insert pipeline records into DynamoDB
    const insertPipelinesRole = new iam.Role(this, 'InsertPipelinesRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });
    props.imagePipelinesTable.grantWriteData(insertPipelinesRole);

    // Grant KMS permissions if tables use customer-managed encryption
    if (props.encryptionKey) {
      props.encryptionKey.grantEncryptDecrypt(insertPipelinesRole);
    }

    for (const record of pipelineRecords) {
      new cr.AwsCustomResource(this, `InsertPipeline${record.macosVersion}`, {
        onCreate: {
          service: 'DynamoDB',
          action: 'putItem',
          parameters: {
            TableName: props.imagePipelinesTable.tableName,
            Item: {
              pipelineId: { S: record.pipelineId },
              name: { S: record.name },
              description: { S: `System pipeline for creating DCV-ready macOS ${record.macosVersion} base images. Rebuilding picks up the latest macOS patches automatically.` },
              status: { S: 'CREATED' },
              platform: { S: 'macOS' },
              baseOsVersion: { S: `macOS ${record.macosVersion}` },
              pipelineArn: { S: record.pipelineArn },
              isSystemPipeline: { BOOL: true },
            },
            ConditionExpression: 'attribute_not_exists(pipelineId)',
          },
          physicalResourceId: cr.PhysicalResourceId.of(record.pipelineId),
        },
        policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
          resources: [props.imagePipelinesTable.tableArn],
        }),
        role: insertPipelinesRole,
      });
    }

    // ============================================
    // OUTPUTS
    // ============================================

    new cdk.CfnOutput(this, 'SystemPipelineIds', {
      value: this.systemPipelineIds.join(','),
      description: 'System pipeline IDs for macOS DCV-Ready base images',
    });

    new cdk.CfnOutput(this, 'MacHostResourceGroupArn', {
      value: `arn:aws:resource-groups:${this.region}:${this.account}:group/${props.pascalCaseName}-Mac-Host-Resource-Group`,
      description: 'ARN of the Mac Host Resource Group for automatic host allocation',
    });

    new cdk.CfnOutput(this, 'MacLicenseConfigurationArn', {
      value: licenseConfigArn,
      description: 'ARN of the License Configuration for macOS Dedicated Hosts (required for Host Resource Group launches)',
    });

    new cdk.CfnOutput(this, 'AddExistingHostsCommand', {
      value: `aws resource-groups group-resources --group ${props.pascalCaseName}-Mac-Host-Resource-Group --resource-arns arn:aws:ec2:${this.region}:${this.account}:dedicated-host/<host-id>`,
      description: 'Command to add existing Mac Dedicated Hosts to the resource group',
    });
  }
}
