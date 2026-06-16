// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as kms from 'aws-cdk-lib/aws-kms';
import { Construct } from 'constructs';

export interface DatabaseConstructProps {
  pascalCaseName: string;
  acronym: string;
  encryptionKey?: kms.IKey;
}

export class DatabaseConstruct extends Construct {
  public readonly userTable: dynamodb.Table;
  public readonly workstationTable: dynamodb.Table;
  public readonly amiTable: dynamodb.Table;
  public readonly groupsTable: dynamodb.Table;
  public readonly storageTable: dynamodb.Table;
  public readonly imagePipelinesTable: dynamodb.Table;
  public readonly softwareLibraryTable: dynamodb.Table;
  public readonly hostnameCounterTable: dynamodb.Table;
  public readonly regionalHubsTable: dynamodb.Table;
  public readonly instanceTypeCatalogTable: dynamodb.Table;

  constructor(scope: Construct, id: string, props: DatabaseConstructProps) {
    super(scope, id);

    // Use lowercase acronym for table names (e.g., "mrm-users")
    const tablePrefix = props.acronym.toLowerCase();

    // Use customer-managed KMS key if provided (CKV_AWS_119)
    const encryptionConfig = props.encryptionKey
      ? { encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED, encryptionKey: props.encryptionKey }
      : { encryption: dynamodb.TableEncryption.AWS_MANAGED };

    // Hostname Counter table - for atomic hostname number generation
    this.hostnameCounterTable = new dynamodb.Table(this, 'HostnameCounterTable', {
      tableName: `${tablePrefix}-hostname-counters`,
      partitionKey: {
        name: 'prefix',
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      ...encryptionConfig,
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: true,
      },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Users table
    this.userTable = new dynamodb.Table(this, 'UsersTable', {
      tableName: `${tablePrefix}-users`,
      partitionKey: {
        name: 'userId',
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      ...encryptionConfig,
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: true,
      },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Add GSI for email lookup
    this.userTable.addGlobalSecondaryIndex({
      indexName: 'email-index',
      partitionKey: {
        name: 'email',
        type: dynamodb.AttributeType.STRING,
      },
    });

    // Workstations table
    this.workstationTable = new dynamodb.Table(this, 'WorkstationsTable', {
      tableName: `${tablePrefix}-workstations`,
      partitionKey: {
        name: 'instanceId',
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      ...encryptionConfig,
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: true,
      },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Add GSI for user assignment lookup
    this.workstationTable.addGlobalSecondaryIndex({
      indexName: 'user-assignment-index',
      partitionKey: {
        name: 'assignedUserId',
        type: dynamodb.AttributeType.STRING,
      },
    });

    // Add GSI for status lookup
    this.workstationTable.addGlobalSecondaryIndex({
      indexName: 'status-index',
      partitionKey: {
        name: 'status',
        type: dynamodb.AttributeType.STRING,
      },
    });

    // Add GSI for group assignment lookup
    this.workstationTable.addGlobalSecondaryIndex({
      indexName: 'group-assignment-index',
      partitionKey: {
        name: 'assignedGroupId',
        type: dynamodb.AttributeType.STRING,
      },
    });

    // Add GSI for pipeline lookup (for workstation naming)
    this.workstationTable.addGlobalSecondaryIndex({
      indexName: 'pipelineId-index',
      partitionKey: {
        name: 'pipelineId',
        type: dynamodb.AttributeType.STRING,
      },
    });

    // AMI Management table
    this.amiTable = new dynamodb.Table(this, 'AmiTable', {
      tableName: `${tablePrefix}-amis`,
      partitionKey: {
        name: 'amiId',
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      ...encryptionConfig,
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: true,
      },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Add GSI for platform lookup
    this.amiTable.addGlobalSecondaryIndex({
      indexName: 'platform-index',
      partitionKey: {
        name: 'platform',
        type: dynamodb.AttributeType.STRING,
      },
    });

    // Groups table
    this.groupsTable = new dynamodb.Table(this, 'GroupsTable', {
      tableName: `${tablePrefix}-groups`,
      partitionKey: {
        name: 'groupId',
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      ...encryptionConfig,
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: true,
      },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Add GSI for group name lookup
    this.groupsTable.addGlobalSecondaryIndex({
      indexName: 'group-name-index',
      partitionKey: {
        name: 'groupName',
        type: dynamodb.AttributeType.STRING,
      },
    });

    // Storage table
    this.storageTable = new dynamodb.Table(this, 'StorageTable', {
      tableName: `${tablePrefix}-storage`,
      partitionKey: {
        name: 'storageId',
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      ...encryptionConfig,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Add GSI for region lookup (for filtering storage by region)
    this.storageTable.addGlobalSecondaryIndex({
      indexName: 'region-index',
      partitionKey: {
        name: 'region',
        type: dynamodb.AttributeType.STRING,
      },
    });

    // Image Pipelines table
    this.imagePipelinesTable = new dynamodb.Table(this, 'ImagePipelinesTable', {
      tableName: `${tablePrefix}-image-pipelines`,
      partitionKey: {
        name: 'pipelineId',
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      ...encryptionConfig,
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: true,
      },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Add GSI for status lookup
    this.imagePipelinesTable.addGlobalSecondaryIndex({
      indexName: 'status-index',
      partitionKey: {
        name: 'status',
        type: dynamodb.AttributeType.STRING,
      },
    });

    // Software Library table
    this.softwareLibraryTable = new dynamodb.Table(this, 'SoftwareLibraryTable', {
      tableName: `${tablePrefix}-software-library`,
      partitionKey: {
        name: 'softwareId',
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      ...encryptionConfig,
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: true,
      },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Add GSI for category lookup
    this.softwareLibraryTable.addGlobalSecondaryIndex({
      indexName: 'category-index',
      partitionKey: {
        name: 'category',
        type: dynamodb.AttributeType.STRING,
      },
    });

    // Regional Hubs table - for multi-region satellite deployments
    this.regionalHubsTable = new dynamodb.Table(this, 'RegionalHubsTable', {
      tableName: `${tablePrefix}-regional-hubs`,
      partitionKey: {
        name: 'region',
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      ...encryptionConfig,
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: true,
      },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Add GSI for status lookup
    this.regionalHubsTable.addGlobalSecondaryIndex({
      indexName: 'status-index',
      partitionKey: {
        name: 'status',
        type: dynamodb.AttributeType.STRING,
      },
    });

    // Instance Type Catalog table - dynamic catalog of EC2 instance types with regional availability
    // Uses TTL to auto-delete deprecated instance types not seen in 7 days
    this.instanceTypeCatalogTable = new dynamodb.Table(this, 'InstanceTypeCatalogTable', {
      tableName: `${tablePrefix}-instance-type-catalog`,
      partitionKey: {
        name: 'instanceType',
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',  // Auto-delete items after TTL expires
      ...encryptionConfig,
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: true,
      },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Add GSI for family lookup (to group instance types by family)
    this.instanceTypeCatalogTable.addGlobalSecondaryIndex({
      indexName: 'family-index',
      partitionKey: {
        name: 'family',
        type: dynamodb.AttributeType.STRING,
      },
    });

    // Create placeholder for frontend URL parameter
    new cdk.CfnResource(this, 'FrontendUrlPlaceholder', {
      type: 'AWS::SSM::Parameter',
      properties: {
        Name: `/${props.pascalCaseName}/Frontend/Url`,
        Value: 'https://placeholder.cloudfront.net',
        Type: 'String',
        Description: 'CloudFront URL for CORS configuration (placeholder, updated by Frontend stack)'
      }
    });
  }
}
