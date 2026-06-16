#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { Aspects } from 'aws-cdk-lib';
import { AwsSolutionsChecks, NagSuppressions } from 'cdk-nag';
import { ApiStack } from '../lib/api-stack';
import { DcvInfrastructureStack } from '../lib/dcv-infrastructure-stack';
import { FrontendStack } from '../lib/frontend-stack';
import { EventBridgeStack } from '../lib/eventbridge-stack';
import { DcvStatusSyncStack } from '../lib/dcv-status-sync-stack';
import { WindowsWorkstationCreationStack } from '../lib/workstation-creation-stack-windows';
import { LinuxWorkstationCreationStack } from '../lib/workstation-creation-stack-linux';
import { MacOSWorkstationCreationStack } from '../lib/workstation-creation-stack-macos';
import { WorkstationStartStack } from '../lib/workstation-start-stack';
import { DCVCleanupStack } from '../lib/dcv-cleanup-stack';
import { InfrastructureStack } from '../lib/infrastructure-stack';
import { StorageStack } from '../lib/storage-stack';
import { MacOSBaseImageStack } from '../lib/macos-base-image-stack';
import { RegionalHubStack } from '../lib/regional-hub-stack';
import { DataSyncStack } from '../lib/datasync-stack';
import { ObservabilityStack } from '../lib/observability-stack';
import { AgentCoreStack } from '../lib/agentcore-stack';
import * as fs from 'fs';
import * as path from 'path';
import * as ssm from 'aws-cdk-lib/aws-ssm';

const app = new cdk.App();

// Load parameters from parameters.json and merge into context
const loadParametersAsContext = () => {
  const parametersPath = path.join(__dirname, '..', 'parameters.json');
  if (fs.existsSync(parametersPath)) {
    try {
      const parametersContent = fs.readFileSync(parametersPath, 'utf-8');
      const parameters = JSON.parse(parametersContent);
      const contextMap: { [key: string]: string } = {};
      
      for (const param of parameters) {
        if (param.ParameterKey && param.ParameterValue) {
          // Convert parameter keys to camelCase for context (e.g., DcvCertificateArn -> dcvCertificateArn)
          const contextKey = param.ParameterKey.charAt(0).toLowerCase() + param.ParameterKey.slice(1);
          contextMap[contextKey] = param.ParameterValue;
        }
      }
      return contextMap;
    } catch (error) {
      console.warn('Warning: Could not parse parameters.json:', error);
      return {};
    }
  }
  return {};
};

// Load certificate file content if path is specified
const loadCertificateFile = (filePath: string | undefined): string | undefined => {
  if (!filePath) return undefined;
  
  // Resolve and validate the path stays within the project directory
  const projectRoot = path.resolve(__dirname, '..');
  // nosemgrep: path-join-resolve-traversal — path is validated against projectRoot on next line
  const fullPath = path.resolve(projectRoot, filePath);
  if (!fullPath.startsWith(projectRoot)) {
    console.warn('Warning: Certificate file path escapes project directory:', filePath);
    return undefined;
  }
  if (fs.existsSync(fullPath)) {
    try {
      return fs.readFileSync(fullPath, 'utf-8');
    } catch (error) {
      console.warn('Warning: Could not read certificate file', filePath, error);
      return undefined;
    }
  }
  console.warn('Warning: Certificate file not found:', filePath);
  return undefined;
};

// Load parameters and make them available via app context
const parametersContext = loadParametersAsContext();

// Helper function to get context value with fallback to parameters.json
const getContextOrParameter = (key: string): string | undefined => {
  // First check CLI context (-c flag), then cdk.json context, then parameters.json
  return app.node.tryGetContext(key) || parametersContext[key] || undefined;
};

// Get product name from context with fallback
const productName = app.node.tryGetContext('productName') || 'Media Resource Manager';

// Utility functions for different naming conventions
const createNamingConventions = (name: string) => {
  // Remove extra spaces and trim
  const cleaned = name.trim().replace(/\s+/g, ' ');
  
  return {
    // Full name with proper spacing for UI display
    displayName: cleaned,
    
    // PascalCase for CloudFormation stacks, resources
    pascalCase: cleaned.replace(/\s+/g, '').replace(/[^a-zA-Z0-9]/g, ''),
    
    // kebab-case for URLs, file names
    kebabCase: cleaned.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, ''),
    
    // Acronym from first letters (e.g., "Media Resource Manager" -> "MRM")
    acronym: cleaned.split(' ').map(word => word.charAt(0).toUpperCase()).join('')
  };
};

const naming = createNamingConventions(productName);

// Apply tags to all resources across all stacks
cdk.Tags.of(app).add('ManagedBy', naming.pascalCase);
cdk.Tags.of(app).add('Product', naming.displayName);

// Utility function to create parameter paths
const getParameterPath = (path: string) => `/${naming.pascalCase}${path}`;

// Get environment configuration
const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION || 'us-east-1',
};

// Core Infrastructure stack (foundational infrastructure)
const infrastructureStack = new InfrastructureStack(app, `${naming.acronym}-Infrastructure`, {
  env,
  productName: naming.displayName,
  pascalCaseName: naming.pascalCase,
  acronym: naming.acronym,
  adminGroupName: getContextOrParameter('adminGroupName'),
  identityCenterSyncGroups: getContextOrParameter('identityCenterSyncGroups'),
  hostnamePrefix: getContextOrParameter('hostnamePrefix'),
  hostnameDigits: getContextOrParameter('hostnameDigits'),
  frontendUrl: getContextOrParameter('frontendUrl'),
  adminEmails: getContextOrParameter('adminEmails'),
  ssoUserPoolArn: getContextOrParameter('ssoUserPoolArn'),
  ssoUserPoolClientId: getContextOrParameter('ssoUserPoolClientId'),
  ssoUserPoolDomain: getContextOrParameter('ssoUserPoolDomain'),
});

// DCV Infrastructure stack
const dcvCertificateContent = loadCertificateFile(getContextOrParameter('dcvCertificateFile'));
const dcvPrivateKeyContent = loadCertificateFile(getContextOrParameter('dcvPrivateKeyFile'));

const dcvStack = new DcvInfrastructureStack(app, `${naming.acronym}-Dcv-Infrastructure`, {
  env,
  productName: naming.displayName,
  pascalCaseName: naming.pascalCase,
  acronym: naming.acronym,
  workstationTableName: infrastructureStack.database.workstationTable.tableName,
  dcvCertificateArn: getContextOrParameter('dcvCertificateArn'),
  dcvDomainName: getContextOrParameter('dcvDomainName'),
  dcvCertificateContent,
  dcvPrivateKeyContent,
  dataEncryptionKey: infrastructureStack.security.dataEncryptionKey,
});
dcvStack.addDependency(infrastructureStack);

// DCV Cleanup stack for automatic server cleanup on instance termination
const dcvCleanupStack = new DCVCleanupStack(app, `${naming.acronym}-Dcv-Cleanup`, {
  env,
  productName: naming.displayName,
  pascalCaseName: naming.pascalCase,
  acronym: naming.acronym,
  workstationTable: infrastructureStack.database.workstationTable,
  vpc: dcvStack.vpc,
  workstationSecurityGroup: dcvStack.workstationSecurityGroup,
  dataEncryptionKey: infrastructureStack.security.dataEncryptionKey,
});
dcvCleanupStack.addDependency(dcvStack);

// DCV Status Sync stack for connection monitoring
const dcvStatusSyncStack = new DcvStatusSyncStack(app, `${naming.acronym}-Dcv-StatusSync`, {
  env,
  productName: naming.displayName,
  pascalCaseName: naming.pascalCase,
  acronym: naming.acronym,
  workstationTable: infrastructureStack.database.workstationTable,
  vpc: dcvStack.vpc,
  dataEncryptionKey: infrastructureStack.security.dataEncryptionKey,
});
dcvStatusSyncStack.addDependency(dcvStack);

// Windows Workstation Creation stack with Step Functions
const windowsWorkstationCreationStack = new WindowsWorkstationCreationStack(app, `${naming.acronym}-Workstation-Windows`, {
  env,
  productName: naming.displayName,
  pascalCaseName: naming.pascalCase,
  acronym: naming.acronym,
  workstationTable: infrastructureStack.database.workstationTable,
  imagePipelinesTable: infrastructureStack.database.imagePipelinesTable,
  amiTable: infrastructureStack.database.amiTable,
  hostnameCounterTable: infrastructureStack.database.hostnameCounterTable,
  vpc: dcvStack.vpc,
  workstationSecurityGroup: dcvStack.workstationSecurityGroup,
  workstationLaunchTemplate: dcvStack.workstationLaunchTemplate,
  sessionCleanupFunction: dcvCleanupStack.sessionCleanupFunction,
  dataEncryptionKey: infrastructureStack.security.dataEncryptionKey,
});
windowsWorkstationCreationStack.addDependency(dcvStack);
windowsWorkstationCreationStack.addDependency(dcvCleanupStack);

// Linux Workstation Creation stack with Step Functions
const linuxWorkstationCreationStack = new LinuxWorkstationCreationStack(app, `${naming.acronym}-Workstation-Linux`, {
  env,
  productName: naming.displayName,
  pascalCaseName: naming.pascalCase,
  acronym: naming.acronym,
  workstationTable: infrastructureStack.database.workstationTable,
  imagePipelinesTable: infrastructureStack.database.imagePipelinesTable,
  amiTable: infrastructureStack.database.amiTable,
  hostnameCounterTable: infrastructureStack.database.hostnameCounterTable,
  regionalHubsTable: infrastructureStack.database.regionalHubsTable,
  vpc: dcvStack.vpc,
  workstationSecurityGroup: dcvStack.workstationSecurityGroup,
  workstationLaunchTemplate: dcvStack.workstationLaunchTemplate,
  sessionCleanupFunction: dcvCleanupStack.sessionCleanupFunction,
  dataEncryptionKey: infrastructureStack.security.dataEncryptionKey,
});
linuxWorkstationCreationStack.addDependency(dcvStack);
linuxWorkstationCreationStack.addDependency(dcvCleanupStack);

// macOS Workstation Creation stack with Step Functions (Dedicated Host support)
const macosWorkstationCreationStack = new MacOSWorkstationCreationStack(app, `${naming.acronym}-Workstation-MacOS`, {
  env,
  productName: naming.displayName,
  pascalCaseName: naming.pascalCase,
  acronym: naming.acronym,
  workstationTable: infrastructureStack.database.workstationTable,
  imagePipelinesTable: infrastructureStack.database.imagePipelinesTable,
  amiTable: infrastructureStack.database.amiTable,
  hostnameCounterTable: infrastructureStack.database.hostnameCounterTable,
  regionalHubsTable: infrastructureStack.database.regionalHubsTable,
  vpc: dcvStack.vpc,
  workstationSecurityGroup: dcvStack.workstationSecurityGroup,
  sessionCleanupFunction: dcvCleanupStack.sessionCleanupFunction,
  dataEncryptionKey: infrastructureStack.security.dataEncryptionKey,
});
macosWorkstationCreationStack.addDependency(dcvStack);
macosWorkstationCreationStack.addDependency(dcvCleanupStack);

// macOS DCV-Ready Base Image Pipeline (System Pipeline)
// This creates a golden AMI with SIP disabled and screen recording permissions for DCV
// Write the resolved mac build subnet ID to SSM so the macOS stack can read it
// without a cross-stack CloudFormation export. This prevents deployment failures
// when MacBuildAvailabilityZone changes (the classic "cannot delete export" error).
const macBuildAz = getContextOrParameter('MacBuildAvailabilityZone');
const macBuildSubnet = macBuildAz
  ? infrastructureStack.network.privateSubnets.find(s => s.availabilityZone === macBuildAz) || infrastructureStack.network.privateSubnets[0]
  : infrastructureStack.network.privateSubnets[0];

new ssm.StringParameter(infrastructureStack, 'MacBuildSubnetIdParam', {
  parameterName: `/${naming.pascalCase}/Network/MacBuildSubnetId`,
  stringValue: macBuildSubnet.subnetId,
  description: 'Subnet ID for macOS Image Builder builds (resolved from MacBuildAvailabilityZone)',
});

const macosBaseImageStack = new MacOSBaseImageStack(app, `${naming.acronym}-Image-MacOS`, {
  env,
  pascalCaseName: naming.pascalCase,
  acronym: naming.acronym,
  imagePipelinesTable: infrastructureStack.database.imagePipelinesTable,
  amiTable: infrastructureStack.database.amiTable,
  logsBucket: infrastructureStack.imageBuilder.logsBucket,
  buildSecurityGroup: infrastructureStack.imageBuilder.buildSecurityGroup,
  encryptionKey: infrastructureStack.security.dataEncryptionKey,
});
macosBaseImageStack.addDependency(infrastructureStack);

// Workstation Start stack with Step Functions for robust starting
const workstationStartStack = new WorkstationStartStack(app, `${naming.acronym}-Workstation-Start`, {
  env,
  productName: naming.displayName,
  pascalCaseName: naming.pascalCase,
  acronym: naming.acronym,
  workstationTableName: infrastructureStack.database.workstationTable.tableName,
  storageTableName: infrastructureStack.database.storageTable.tableName,
  progressTableName: `${naming.acronym.toLowerCase()}-progress`, // Created in WorkstationManagementStack
  checkDCVReadinessFunction: windowsWorkstationCreationStack.checkDCVReadinessFunction,
  checkInstanceStatusFunction: windowsWorkstationCreationStack.checkInstanceStatusFunction,
  checkSessionStatusFunction: windowsWorkstationCreationStack.checkSessionStatusFunction,
  deleteTestSessionFunction: windowsWorkstationCreationStack.deleteTestSessionFunction,
  verifySessionDeletedFunction: windowsWorkstationCreationStack.verifySessionDeletedFunction,
  dataEncryptionKey: infrastructureStack.security.dataEncryptionKey,
  vpc: dcvStack.vpc,
  workstationSecurityGroup: dcvStack.workstationSecurityGroup,
});
workstationStartStack.addDependency(windowsWorkstationCreationStack);
workstationStartStack.addDependency(dcvStack);

// Storage stack for storage resource management
const storageStack = new StorageStack(app, `${naming.acronym}-Storage`, {
  env,
  storageTable: infrastructureStack.database.storageTable,
  workstationTable: infrastructureStack.database.workstationTable,
  regionalHubsTable: infrastructureStack.database.regionalHubsTable,
  pascalCaseName: naming.pascalCase,
  acronym: naming.acronym,
  dataEncryptionKey: infrastructureStack.security.dataEncryptionKey,
  authenticatedRoleArn: infrastructureStack.auth.authenticatedRole.roleArn,
});
storageStack.addDependency(infrastructureStack);
storageStack.addDependency(dcvStack);

// Regional Hub stack for multi-region deployment
const regionalHubStack = new RegionalHubStack(app, `${naming.acronym}-Regional-Hub`, {
  env,
  regionalHubsTable: infrastructureStack.database.regionalHubsTable,
  amiTable: infrastructureStack.database.amiTable,
  workstationTable: infrastructureStack.database.workstationTable,
  pascalCaseName: naming.pascalCase,
  acronym: naming.acronym,
  dataEncryptionKey: infrastructureStack.security.dataEncryptionKey,
});
regionalHubStack.addDependency(infrastructureStack);

// DataSync stack for data transfer management
const dataSyncStack = new DataSyncStack(app, `${naming.acronym}-DataSync`, {
  env,
  storageTable: infrastructureStack.database.storageTable,
  pascalCaseName: naming.pascalCase,
  acronym: naming.acronym,
  dataEncryptionKey: infrastructureStack.security.dataEncryptionKey,
});
dataSyncStack.addDependency(infrastructureStack);

// Feature flag for Bedrock/AI features
const enableBedrockFeatures = getContextOrParameter('enableBedrockFeatures') !== 'false'; // defaults to true

// Observability and AgentCore stacks (only when Bedrock features are enabled)
let observabilityStack: ObservabilityStack | undefined;
let agentCoreStack: AgentCoreStack | undefined;

if (enableBedrockFeatures) {
  // Observability stack for Bedrock logging and monitoring
  observabilityStack = new ObservabilityStack(app, `${naming.acronym}-Observability`, {
    env,
    pascalCaseName: naming.pascalCase,
    acronym: naming.acronym,
    encryptionKey: infrastructureStack.security.dataEncryptionKey,
  });
  observabilityStack.addDependency(infrastructureStack);

  // AgentCore stack for AI Install Script Agent
  agentCoreStack = new AgentCoreStack(app, `${naming.acronym}-AgentCore`, {
    env,
    pascalCaseName: naming.pascalCase,
    acronym: naming.acronym,
    encryptionKey: infrastructureStack.security.dataEncryptionKey,
    softwareLibraryTable: infrastructureStack.database.softwareLibraryTable,
    uploadsBucket: infrastructureStack.imageBuilder.uploadsBucket.bucketName,
    agentLogGroup: observabilityStack.agentLogGroup,
  });
  agentCoreStack.addDependency(observabilityStack);
}

// Main workstation management stack
const apiStack = new ApiStack(app, `${naming.acronym}-Api`, {
  env,
  productName: naming.displayName,
  pascalCaseName: naming.pascalCase,
  acronym: naming.acronym,
  userTable: infrastructureStack.database.userTable,
  workstationTable: infrastructureStack.database.workstationTable,
  amiTable: infrastructureStack.database.amiTable,
  groupsTable: infrastructureStack.database.groupsTable,
  imagePipelinesTable: infrastructureStack.database.imagePipelinesTable,
  softwareLibraryTable: infrastructureStack.database.softwareLibraryTable,
  regionalHubsTable: infrastructureStack.database.regionalHubsTable,
  instanceTypeCatalogTable: infrastructureStack.database.instanceTypeCatalogTable,
  windowsWorkstationCreationStateMachine: windowsWorkstationCreationStack.stateMachine,
  linuxWorkstationCreationStateMachine: linuxWorkstationCreationStack.stateMachine,
  // macOS state machine ARN is imported from SSM to avoid CloudFormation export dependencies
  workstationStartStateMachine: workstationStartStack.stateMachineArn,
  vpc: dcvStack.vpc,
  storageTable: infrastructureStack.database.storageTable,
  storageStack: storageStack,
  dataSyncStack: dataSyncStack,
  imageBuilderInstanceProfile: infrastructureStack.imageBuilder.instanceProfile.instanceProfileName!,
  imageBuilderLogsBucket: infrastructureStack.imageBuilder.logsBucket.bucketName,
  imageBuilderServiceRoleArn: infrastructureStack.imageBuilder.serviceRole.roleArn,
  imageBuilderUploadsBucket: infrastructureStack.imageBuilder.uploadsBucket.bucketName,
  buildSubnetId: infrastructureStack.network.privateSubnets[0].subnetId,
  buildSecurityGroupId: infrastructureStack.imageBuilder.buildSecurityGroup.securityGroupId,
  dataEncryptionKey: infrastructureStack.security.dataEncryptionKey,
  // Install Script Agent tables (only when Bedrock features are enabled)
  agentExecutionStateTable: agentCoreStack?.agentExecutionStateTable,
  agentUsageTable: agentCoreStack?.agentUsageTable,
  agentProgressTable: agentCoreStack?.agentProgressTable,
  scriptGenerationStateMachine: agentCoreStack?.scriptGenerationStateMachine,
  enableBedrockFeatures,
});
apiStack.addDependency(workstationStartStack);
apiStack.addDependency(linuxWorkstationCreationStack);
apiStack.addDependency(macosWorkstationCreationStack);
apiStack.addDependency(storageStack);
apiStack.addDependency(dataSyncStack);
if (agentCoreStack) {
  apiStack.addDependency(agentCoreStack);
}

// WAF IP whitelist from parameters (optional - when set, restricts CloudFront access)
// Stored as comma-separated CIDRs in parameters.json: "203.0.113.0/24,198.51.100.0/24"
const wafAllowedIpsParam = getContextOrParameter('wafAllowedIps');
const wafAllowedIps: string[] | undefined = wafAllowedIpsParam
  ? wafAllowedIpsParam.split(',').map(ip => ip.trim()).filter(ip => ip)
  : undefined;

// WAF stack - always deployed in us-east-1 (AWS requirement for CloudFront-scoped WAF)
// Includes AWS Managed Rules for all deployments, plus IP whitelist when configured
import { WafStack } from '../lib/waf-stack';

const wafStack = new WafStack(app, `${naming.acronym}-Waf`, {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: 'us-east-1',
  },
  crossRegionReferences: true,
  productName: naming.displayName,
  pascalCaseName: naming.pascalCase,
  wafAllowedIps,
});

// Frontend stack for web interface
const frontendStack = new FrontendStack(app, `${naming.acronym}-Frontend`, {
  env,
  crossRegionReferences: true,
  productName: naming.displayName,
  pascalCaseName: naming.pascalCase,
  acronym: naming.acronym,
  apiUrl: apiStack.api.url,
  dataEncryptionKey: infrastructureStack.security.dataEncryptionKey,
  userTableName: infrastructureStack.database.userTable.tableName,
  workstationTableName: infrastructureStack.database.workstationTable.tableName,
  frontendUrl: getContextOrParameter('frontendUrl'),
  frontendCertificateArn: getContextOrParameter('frontendCertificateArn'),
  enableBedrockFeatures,
  webAclArn: wafStack.webAclArn,
});
frontendStack.addDependency(apiStack);
frontendStack.addDependency(wafStack);

// EventBridge stack for EC2 state monitoring
const eventBridgeStack = new EventBridgeStack(app, `${naming.acronym}-Events`, {
  env,
  productName: naming.displayName,
  pascalCaseName: naming.pascalCase,
  acronym: naming.acronym,
  workstationTable: infrastructureStack.database.workstationTable,
  userTable: infrastructureStack.database.userTable,
  dcvSessionManagerFunctionArn: apiStack.dcvSessionManagerFunction.functionArn,
  imagePipelinesTable: infrastructureStack.database.imagePipelinesTable,
  imagesTable: infrastructureStack.database.amiTable,
  instanceTypeCatalogTable: infrastructureStack.database.instanceTypeCatalogTable,
  regionalHubsTable: infrastructureStack.database.regionalHubsTable,
  startStateMachineArn: workstationStartStack.stateMachineArn,
  configGeneratorFunction: frontendStack.configGeneratorFunction,
  dataEncryptionKey: infrastructureStack.security.dataEncryptionKey,
});
eventBridgeStack.addDependency(apiStack);
eventBridgeStack.addDependency(frontendStack);
eventBridgeStack.addDependency(workstationStartStack);



NagSuppressions.addStackSuppressions(frontendStack, [
  {
    id: 'AwsSolutions-IAM4',
    reason: 'AWS managed policies are acceptable for deployment functions',
    appliesTo: [
      'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
    ],
  },
  {
    id: 'AwsSolutions-IAM5',
    reason: 'Wildcard permissions needed for S3 deployment operations',
    appliesTo: [
      'Action::s3:*',
      'Action::s3:Abort*',
      'Action::s3:DeleteObject*',
      'Action::s3:GetBucket*',
      'Action::s3:GetObject*',
      'Action::s3:List*',
      'Resource::<*>/*',
      'Resource::*',
      'Resource::<WebsiteBucket75C24D94.Arn>/*',
      'Resource::arn:aws:s3:::cdk-hnb659fds-assets-585473054018-us-east-1/*',
      'Resource::<ConfigGenerator21867CF3.Arn>:*',
      'Resource::<UpdateParameterFunction9B3719FF.Arn>:*',
    ],
  },
  {
    id: 'AwsSolutions-S1',
    reason: 'S3 access logging will be enabled in production',
  },
  {
    id: 'AwsSolutions-S10',
    reason: 'SSL-only access will be enforced in production',
  },
  {
    id: 'AwsSolutions-CFR1',
    reason: 'CloudFront geo restrictions not required for internal workstation access',
  },
  {
    id: 'AwsSolutions-CFR2',
    reason: 'WAF not required for internal workstation management interface',
  },
  {
    id: 'AwsSolutions-CFR3',
    reason: 'CloudFront access logging will be enabled in production',
  },
  {
    id: 'AwsSolutions-CFR4',
    reason: 'Custom SSL certificate will be configured in production',
  },
  {
    id: 'AwsSolutions-L1',
    reason: 'Lambda runtime versions will be updated in future iterations',
  },
]);


NagSuppressions.addStackSuppressions(dcvStack, [
  {
    id: 'AwsSolutions-IAM4',
    reason: 'AWS managed policies are acceptable for DCV infrastructure components',
    appliesTo: [
      'Policy::arn:<AWS::Partition>:iam::aws:policy/AmazonSSMManagedInstanceCore',
      'Policy::arn:<AWS::Partition>:iam::aws:policy/CloudWatchAgentServerPolicy',
    ],
  },
  {
    id: 'AwsSolutions-IAM5',
    reason: 'Wildcard permissions needed for dynamic DCV resource management',
    appliesTo: [
      'Resource::*',
      'Resource::arn:aws:dynamodb:*:*:*',
      'Resource::arn:aws:ssm:*:*:parameter/*',
    ],
  },
  {
    id: 'AwsSolutions-EC23',
    reason: 'Security group allows necessary ports for DCV workstation access',
  },
  {
    id: 'AwsSolutions-EC26',
    reason: 'EBS encryption will be enabled in production environment',
  },
  {
    id: 'AwsSolutions-AS3',
    reason: 'Auto Scaling notifications will be configured in production',
  },
  {
    id: 'AwsSolutions-ELB2',
    reason: 'Load balancer access logs will be enabled in production',
  },
  {
    id: 'AwsSolutions-VPC7',
    reason: 'VPC Flow Logs will be enabled in production environment',
  },
]);

NagSuppressions.addStackSuppressions(windowsWorkstationCreationStack, [
  {
    id: 'AwsSolutions-IAM4',
    reason: 'AWS managed policies are acceptable for Lambda execution roles',
    appliesTo: [
      'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
      'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole',
    ],
  },
  {
    id: 'AwsSolutions-IAM5',
    reason: 'Wildcard permissions needed for workstation creation and management',
    appliesTo: [
      'Resource::*', 
      'Resource::<*>:*',
    ],
  },
  {
    id: 'AwsSolutions-SF1',
    reason: 'Step Function logging will be enabled in production',
  },
  {
    id: 'AwsSolutions-SF2',
    reason: 'X-Ray tracing will be enabled in production',
  },
]);

NagSuppressions.addStackSuppressions(linuxWorkstationCreationStack, [
  {
    id: 'AwsSolutions-IAM4',
    reason: 'AWS managed policies are acceptable for Lambda execution roles',
    appliesTo: [
      'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
      'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole',
    ],
  },
  {
    id: 'AwsSolutions-IAM5',
    reason: 'Wildcard permissions needed for Linux workstation creation and management',
    appliesTo: [
      'Resource::*', 
      'Resource::<*>:*',
    ],
  },
  {
    id: 'AwsSolutions-SF1',
    reason: 'Step Function logging will be enabled in production',
  },
  {
    id: 'AwsSolutions-SF2',
    reason: 'X-Ray tracing will be enabled in production',
  },
]);

NagSuppressions.addStackSuppressions(macosWorkstationCreationStack, [
  {
    id: 'AwsSolutions-IAM4',
    reason: 'AWS managed policies are acceptable for Lambda execution roles',
    appliesTo: [
      'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
      'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole',
    ],
  },
  {
    id: 'AwsSolutions-IAM5',
    reason: 'Wildcard permissions needed for macOS workstation creation and Dedicated Host management',
    appliesTo: [
      'Resource::*', 
      'Resource::<*>:*',
    ],
  },
  {
    id: 'AwsSolutions-SF1',
    reason: 'Step Function logging will be enabled in production',
  },
  {
    id: 'AwsSolutions-SF2',
    reason: 'X-Ray tracing will be enabled in production',
  },
]);

NagSuppressions.addStackSuppressions(workstationStartStack, [
  {
    id: 'AwsSolutions-IAM4',
    reason: 'AWS managed policies are acceptable for Lambda execution roles',
    appliesTo: [
      'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
    ],
  },
  {
    id: 'AwsSolutions-IAM5',
    reason: 'Wildcard permissions needed for workstation start operations',
    appliesTo: [
      'Resource::*', 
      'Resource::<*>:*',
    ],
  },
  {
    id: 'AwsSolutions-L1',
    reason: 'Lambda runtime versions will be updated in future iterations',
  },
  {
    id: 'AwsSolutions-SF1',
    reason: 'Step Function logging will be enabled in production',
  },
  {
    id: 'AwsSolutions-SF2',
    reason: 'X-Ray tracing will be enabled in production',
  },
]);

NagSuppressions.addStackSuppressions(apiStack, [
  {
    id: 'AwsSolutions-IAM4',
    reason: 'AWS managed policies are acceptable for Lambda execution roles',
    appliesTo: [
      'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
      'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole',
    ],
  },
  {
    id: 'AwsSolutions-IAM5',
    reason: 'Wildcard permissions needed for workstation management operations',
    appliesTo: [
      'Resource::*',
      'Resource::<*>/*',
      'Resource::arn:aws:ssm:*:*:parameter/*',
      'Action::s3:*',
    ],
  },
  {
    id: 'AwsSolutions-APIG1',
    reason: 'API Gateway access logging will be enabled in production',
  },
  {
    id: 'AwsSolutions-APIG2',
    reason: 'Request validation will be implemented in production',
  },
  {
    id: 'AwsSolutions-APIG3',
    reason: 'WAF will be configured in production environment',
  },
  {
    id: 'AwsSolutions-APIG4',
    reason: 'Some endpoints intentionally allow public access for authentication',
  },
  {
    id: 'AwsSolutions-APIG6',
    reason: 'CloudWatch logging will be enabled in production',
  },
  {
    id: 'AwsSolutions-COG4',
    reason: 'Custom authorization strategy implemented for workstation management',
  },
  {
    id: 'AwsSolutions-L1',
    reason: 'Lambda runtime versions will be updated in future iterations',
  },
]);

[dcvCleanupStack, dcvStatusSyncStack, eventBridgeStack].forEach(stack => {
  NagSuppressions.addStackSuppressions(stack, [
    {
      id: 'AwsSolutions-IAM4',
      reason: 'AWS managed policies are acceptable for Lambda execution roles',
      appliesTo: [
        'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
        'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole',
      ],
    },
    {
      id: 'AwsSolutions-IAM5',
      reason: 'Wildcard permissions needed for cleanup and monitoring operations',
      appliesTo: [
        'Resource::*',
        'Resource::<*>/index/*',
        'Resource::arn:aws:ssm:*:*:parameter/*',
      ],
    },
  ]);
});

NagSuppressions.addStackSuppressions(macosBaseImageStack, [
  {
    id: 'AwsSolutions-IAM4',
    reason: 'AWS managed policies are acceptable for Image Builder and Lambda execution roles',
    appliesTo: [
      'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
      'Policy::arn:<AWS::Partition>:iam::aws:policy/EC2InstanceProfileForImageBuilder',
      'Policy::arn:<AWS::Partition>:iam::aws:policy/AmazonSSMManagedInstanceCore',
    ],
  },
  {
    id: 'AwsSolutions-IAM5',
    reason: 'Wildcard permissions needed for SIP orchestration and Image Builder operations',
    appliesTo: [
      'Resource::*',
    ],
  },
  {
    id: 'AwsSolutions-L1',
    reason: 'Lambda runtime versions will be updated in future iterations',
  },
]);

NagSuppressions.addStackSuppressions(regionalHubStack, [
  {
    id: 'AwsSolutions-IAM4',
    reason: 'AWS managed policies are acceptable for Lambda execution roles',
    appliesTo: [
      'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
    ],
  },
  {
    id: 'AwsSolutions-IAM5',
    reason: 'Wildcard permissions needed for cross-region CloudFormation deployment and resource management',
    appliesTo: [
      'Resource::*',
    ],
  },
  {
    id: 'AwsSolutions-S1',
    reason: 'S3 access logging will be enabled in production',
  },
  {
    id: 'AwsSolutions-SF1',
    reason: 'Step Function logging will be enabled in production',
  },
  {
    id: 'AwsSolutions-SF2',
    reason: 'X-Ray tracing will be enabled in production',
  },
]);

NagSuppressions.addStackSuppressions(dataSyncStack, [
  {
    id: 'AwsSolutions-IAM4',
    reason: 'AWS managed policies are acceptable for Lambda execution roles',
    appliesTo: [
      'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
    ],
  },
  {
    id: 'AwsSolutions-IAM5',
    reason: 'Wildcard permissions needed for DataSync API operations and S3 bucket access',
    appliesTo: [
      'Resource::*',
    ],
  },
  {
    id: 'AwsSolutions-SF1',
    reason: 'Step Function logging will be enabled in production',
  },
  {
    id: 'AwsSolutions-SF2',
    reason: 'X-Ray tracing will be enabled in production',
  },
]);

if (observabilityStack) {
  NagSuppressions.addStackSuppressions(observabilityStack, [
    {
      id: 'AwsSolutions-IAM4',
      reason: 'AWS managed policies are acceptable for Lambda execution roles',
      appliesTo: [
        'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
      ],
    },
    {
      id: 'AwsSolutions-IAM5',
      reason: 'Wildcard permissions needed for Bedrock logging configuration',
      appliesTo: [
        'Resource::*',
      ],
    },
    {
      id: 'AwsSolutions-S1',
      reason: 'S3 access logging will be enabled in production',
    },
  ]);
}

if (agentCoreStack) {
  NagSuppressions.addStackSuppressions(agentCoreStack, [
    {
      id: 'AwsSolutions-IAM4',
      reason: 'AWS managed policies are acceptable for agent execution roles',
      appliesTo: [
        'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
      ],
    },
    {
      id: 'AwsSolutions-IAM5',
      reason: 'Wildcard permissions needed for agent operations including EC2, SSM, Bedrock, and Image Builder',
      appliesTo: [
        'Resource::*',
      ],
    },
  ]);
}
