// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { DatabaseConstruct } from './constructs/database-construct';
import { AuthConstruct } from './constructs/auth-construct';
import { NetworkConstruct } from './constructs/network-construct';
import { IdentityConstruct } from './constructs/identity-construct';
import { ImageBuilderConstruct } from './constructs/imagebuilder-construct';
import { SecurityConstruct } from './constructs/security-construct';

export interface InfrastructureStackProps extends cdk.StackProps {
  productName: string;
  pascalCaseName: string;
  acronym: string;
  adminGroupName?: string;
  identityCenterSyncGroups?: string;
  hostnamePrefix?: string;
  hostnameDigits?: string;
  frontendUrl?: string;
  adminEmails?: string;
  /** Optional: ARN of an external SSO User Pool to import */
  ssoUserPoolArn?: string;
  /** Optional: Client ID of the external SSO User Pool */
  ssoUserPoolClientId?: string;
  /** Optional: Domain URL of the external SSO User Pool */
  ssoUserPoolDomain?: string;
}

export class InfrastructureStack extends cdk.Stack {
  public readonly database: DatabaseConstruct;
  public readonly auth: AuthConstruct;
  public readonly network: NetworkConstruct;
  public readonly identity: IdentityConstruct;
  public readonly imageBuilder: ImageBuilderConstruct;
  public readonly security: SecurityConstruct;

  constructor(scope: Construct, id: string, props: InfrastructureStackProps) {
    super(scope, id, {
      ...props,
      description: "Core infrastructure including VPC, Active Directory, DynamoDB tables, and Cognito authentication",
      suppressTemplateIndentation: true, // Reduce template size for large stacks
    });

    // Parameter for authentication mode
    const useCognitoAuth = new cdk.CfnParameter(this, 'UseCognitoAuth', {
      type: 'String',
      default: 'true',
      allowedValues: ['true', 'false'],
      description: 'Use Cognito authentication (true) or AWS Managed AD (false)',
    });

    // Parameter for admin group name (only used with Cognito auth)
    // Use prop value if provided, otherwise fall back to default
    const adminGroupNameValue = props.adminGroupName || 'MRM-Admins';

    // Network construct (VPC, subnets)
    this.network = new NetworkConstruct(this, 'Network', {
      pascalCaseName: props.pascalCaseName,
    });

    // Security construct (KMS keys, DLQ) - create early for use by other constructs
    this.security = new SecurityConstruct(this, 'Security', {
      pascalCaseName: props.pascalCaseName,
    });

    // Database construct - use KMS encryption
    this.database = new DatabaseConstruct(this, 'Database', {
      pascalCaseName: props.pascalCaseName,
      acronym: props.acronym,
      encryptionKey: this.security.dataEncryptionKey,
    });

    // Identity construct (AWS Managed AD) - depends on network and database
    this.identity = new IdentityConstruct(this, 'Identity', {
      vpc: this.network.vpc,
      privateSubnets: this.network.privateSubnets,
      pascalCaseName: props.pascalCaseName,
      acronym: props.acronym,
      userTableName: this.database.userTable.tableName,
      encryptionKey: this.security.dataEncryptionKey,
    });
    this.identity.node.addDependency(this.network);
    this.identity.node.addDependency(this.database);

    // Auth construct - depends on database for frontend URL placeholder parameter
    this.auth = new AuthConstruct(this, 'Auth', {
      pascalCaseName: props.pascalCaseName,
      acronym: props.acronym,
      productName: props.productName,
      encryptionKey: this.security.dataEncryptionKey,
      adminGroupName: props.adminGroupName,
      frontendUrl: props.frontendUrl,
      adminEmails: props.adminEmails,
      ssoUserPoolArn: props.ssoUserPoolArn,
      ssoUserPoolClientId: props.ssoUserPoolClientId,
      ssoUserPoolDomain: props.ssoUserPoolDomain,
    });
    this.auth.node.addDependency(this.database);

    // Image Builder construct
    this.imageBuilder = new ImageBuilderConstruct(this, 'ImageBuilder', {
      pascalCaseName: props.pascalCaseName,
      acronym: props.acronym,
      vpc: this.network.vpc,
      privateSubnets: this.network.privateSubnets,
      encryptionKey: this.security.dataEncryptionKey,
    });
    this.imageBuilder.node.addDependency(this.network);

    // DynamoDB Gateway VPC Endpoint (free - no hourly or data charges)
    // Required for VPC Lambda functions to reach DynamoDB without going through NAT gateway.
    // For CDK-created VPCs, the L2 construct auto-associates with route tables.
    // For imported VPCs, we use L1 with route table IDs from parameters.json
    // (captured by analyze-vpc.sh during deployment).
    const privateRouteTableIds = this.network.privateRouteTableIds;
    if (privateRouteTableIds && privateRouteTableIds.length > 0) {
      // Imported VPC with known route tables — use L1 with explicit route table IDs
      new cdk.aws_ec2.CfnVPCEndpoint(this, 'DynamoDBEndpoint', {
        vpcId: this.network.vpc.vpcId,
        serviceName: `com.amazonaws.${this.region}.dynamodb`,
        vpcEndpointType: 'Gateway',
        routeTableIds: privateRouteTableIds,
      });
    } else {
      // CDK-created VPC — L2 construct auto-associates with all route tables
      try {
        new cdk.aws_ec2.GatewayVpcEndpoint(this, 'DynamoDBEndpoint', {
          vpc: this.network.vpc,
          service: cdk.aws_ec2.GatewayVpcEndpointAwsService.DYNAMODB,
        });
      } catch (e) {
        console.log('DynamoDB endpoint: L2 failed, using L1 fallback (route tables may need manual association)');
        new cdk.aws_ec2.CfnVPCEndpoint(this, 'DynamoDBEndpointL1', {
          vpcId: this.network.vpc.vpcId,
          serviceName: `com.amazonaws.${this.region}.dynamodb`,
          vpcEndpointType: 'Gateway',
        });
      }
    }

    // Store authentication mode in SSM for frontend config
    new cdk.aws_ssm.StringParameter(this, 'AuthModeParameter', {
      parameterName: `/${props.pascalCaseName}/Auth/UseCognitoAuth`,
      stringValue: useCognitoAuth.valueAsString,
      description: 'Authentication mode: true for Cognito, false for AWS Managed AD',
    });

    new cdk.aws_ssm.StringParameter(this, 'AdminGroupNameParameter', {
      parameterName: `/${props.pascalCaseName}/Auth/AdminGroupName`,
      stringValue: adminGroupNameValue,
      description: 'Admin group name for Cognito/SAML authentication',
    });

    // Store Identity Center sync groups in SSM (if provided)
    if (props.identityCenterSyncGroups) {
      new cdk.aws_ssm.StringParameter(this, 'IdentityCenterSyncGroupsParameter', {
        parameterName: `/${props.pascalCaseName}/Identity/SyncGroups`,
        stringValue: props.identityCenterSyncGroups,
        description: 'Identity Center group IDs to sync users from (comma-separated)',
      });
    }

    // Store hostname configuration in SSM
    new cdk.aws_ssm.StringParameter(this, 'HostnamePrefixParameter', {
      parameterName: `/${props.pascalCaseName}/Workstation/HostnamePrefix`,
      stringValue: props.hostnamePrefix || 'vdi-',
      description: 'Prefix for workstation hostnames (e.g., tegna-vdi-)',
    });

    new cdk.aws_ssm.StringParameter(this, 'HostnameDigitsParameter', {
      parameterName: `/${props.pascalCaseName}/Workstation/HostnameDigits`,
      stringValue: props.hostnameDigits || '4',
      description: 'Number of digits for hostname suffix (4 = 0001-9999)',
    });

    // Outputs
    new cdk.CfnOutput(this, 'UserTableName', {
      value: this.database.userTable.tableName,
      description: 'DynamoDB Users Table Name',
    });

    new cdk.CfnOutput(this, 'WorkstationTableName', {
      value: this.database.workstationTable.tableName,
      description: 'DynamoDB Workstations Table Name',
    });

    new cdk.CfnOutput(this, 'AmiTableName', {
      value: this.database.amiTable.tableName,
      description: 'DynamoDB AMI Table Name',
    });

    new cdk.CfnOutput(this, 'GroupsTableName', {
      value: this.database.groupsTable.tableName,
      description: 'DynamoDB Groups Table Name',
    });

    new cdk.CfnOutput(this, 'ImagePipelinesTableName', {
      value: this.database.imagePipelinesTable.tableName,
      description: 'DynamoDB Image Pipelines Table Name',
    });

    new cdk.CfnOutput(this, 'HostnameCounterTableName', {
      value: this.database.hostnameCounterTable.tableName,
      description: 'DynamoDB Hostname Counter Table Name',
    });

    new cdk.CfnOutput(this, 'RegionalHubsTableName', {
      value: this.database.regionalHubsTable.tableName,
      description: 'DynamoDB Regional Hubs Table Name',
    });

    new cdk.CfnOutput(this, 'InstanceTypeCatalogTableName', {
      value: this.database.instanceTypeCatalogTable.tableName,
      description: 'DynamoDB Instance Type Catalog Table Name',
    });

    new cdk.CfnOutput(this, 'ImageBuilderUploadsBucket', {
      value: this.imageBuilder.uploadsBucket.bucketName,
      description: 'S3 Bucket for Image Builder uploads',
    });

    new cdk.CfnOutput(this, 'LdapLayerArn', {
      value: this.auth.ldapLayer.layerVersionArn,
      description: 'LDAP Layer ARN',
    });
  }
}
