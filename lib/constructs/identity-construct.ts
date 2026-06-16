// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import * as ds from 'aws-cdk-lib/aws-directoryservice';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as route53resolver from 'aws-cdk-lib/aws-route53resolver';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as kms from 'aws-cdk-lib/aws-kms';
import { Construct } from 'constructs';
import * as fs from 'fs';
import * as path from 'path';

interface IdentityParams {
  DomainName?: string;
}

export interface IdentityConstructProps {
  vpc: ec2.IVpc;
  privateSubnets: ec2.ISubnet[];
  pascalCaseName: string;
  acronym: string;
  userTableName: string;
  encryptionKey?: kms.IKey;
}

export class IdentityConstruct extends Construct {
  public readonly managedAd: ds.CfnMicrosoftAD;
  private readonly pascalCaseName: string;
  private readonly acronym: string;

  constructor(scope: Construct, id: string, props: IdentityConstructProps) {
    super(scope, id);

    this.pascalCaseName = props.pascalCaseName;
    this.acronym = props.acronym;

    // Load parameters from file
    const params = this.loadParameters();
    const domainName = params.DomainName || 'studio.mrm.internal';

    // Generate admin password for built-in Admin user (CKV_AWS_149: use KMS CMK)
    const defaultAdminSecret = new secretsmanager.Secret(this, 'DefaultAdminSecret', {
      secretName: `/${props.pascalCaseName}/Identity/DefaultAdminActiveDirectoryLoginCredentials`,
      description: 'Default Admin AD Credentials',
      encryptionKey: props.encryptionKey,
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: 'Admin' }),
        generateStringKey: 'password',
        excludeCharacters: '"@/\\',
        includeSpace: false,
        passwordLength: 32,
        requireEachIncludedType: true,
      },
    });

    // Create AWS Managed AD
    this.managedAd = new ds.CfnMicrosoftAD(this, 'ManagedAD', {
      name: domainName,
      password: defaultAdminSecret.secretValueFromJson('password').unsafeUnwrap(),
      edition: 'Standard',
      vpcSettings: {
        subnetIds: [props.privateSubnets[0].subnetId, props.privateSubnets[1].subnetId],
        vpcId: props.vpc.vpcId,
      },
    });

    // Create service account secrets with specific names (CKV_AWS_149: use KMS CMK)
    const resourceAdminSecret = new secretsmanager.Secret(this, 'ResourceAdminSecret', {
      secretName: `/${props.pascalCaseName}/Identity/ResourceAdminActiveDirectoryLoginCredentials`,
      description: 'Resource Admin AD Credentials',
      encryptionKey: props.encryptionKey,
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: 'ResourceAdmin' }),
        generateStringKey: 'password',
        excludeCharacters: '"@/\\',
        includeSpace: false,
        passwordLength: 32,
        requireEachIncludedType: true,
      },
    });



    const adConnectorSecret = new secretsmanager.Secret(this, 'AdConnectorSecret', {
      secretName: `/${props.pascalCaseName}/Identity/AdConnectorServiceAccountActiveDirectoryLoginCredentials`,
      description: 'AD Connector Service Account Credentials',
      encryptionKey: props.encryptionKey,
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: 'RM_AdConnectorUser' }),
        generateStringKey: 'password',
        excludeCharacters: '"@/\\',
        includeSpace: false,
        passwordLength: 32,
        requireEachIncludedType: true,
      },
    });

    // Create Route 53 Resolver for AD DNS resolution
    this.createDnsResolver(domainName, props.vpc, props.privateSubnets, props.pascalCaseName);

    // Enable Directory Data Access before creating users
    this.enableDirectoryDataAccess();

    // Create AD users using Custom Resources
    this.createAdUsers(resourceAdminSecret, adConnectorSecret, props.userTableName, props.pascalCaseName, props.encryptionKey);

    // Store parameters in SSM
    this.createSSMParameters(domainName, resourceAdminSecret, adConnectorSecret, defaultAdminSecret, props.pascalCaseName);

    // Outputs
    new cdk.CfnOutput(this, 'ManagedADId', {
      value: this.managedAd.ref,
      description: 'AWS Managed AD Directory ID',
    });

    new cdk.CfnOutput(this, 'DomainName', {
      value: domainName,
      description: 'Active Directory Domain Name',
    });
  }

  private loadParameters(): IdentityParams {
    const paramsPath = path.join(process.cwd(), 'parameters.json');
    if (!fs.existsSync(paramsPath)) return {};

    const paramsArray = JSON.parse(fs.readFileSync(paramsPath, 'utf8'));
    return paramsArray.reduce((acc: IdentityParams, param: any) => {
      acc[param.ParameterKey as keyof IdentityParams] = param.ParameterValue;
      return acc;
    }, {});
  }

  private enableDirectoryDataAccess() {
    // Lambda function to enable Directory Data Access
    const enableDataAccessFunction = new lambda.Function(this, 'EnableDataAccessFunction', {
      functionName: `${this.acronym.toLowerCase()}-enable-directory-data-access`,
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      reservedConcurrentExecutions: 5,
      code: lambda.Code.fromAsset(path.join(__dirname, '../../lambda/enable-directory-data-access')),
      timeout: cdk.Duration.minutes(5),
    });

    // Grant permissions to enable directory data access
    enableDataAccessFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['ds:EnableDirectoryDataAccess'],
        resources: [`arn:aws:ds:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:directory/${this.managedAd.ref}`],
      })
    );

    // Custom resource to enable Directory Data Access
    new cdk.CustomResource(this, 'EnableDirectoryDataAccess', {
      serviceToken: enableDataAccessFunction.functionArn,
      properties: {
        DirectoryId: this.managedAd.ref,
      },
    });
  }

  private createSSMParameters(
    domainName: string,
    resourceAdminSecret: secretsmanager.Secret,
    adConnectorSecret: secretsmanager.Secret,
    defaultAdminSecret: secretsmanager.Secret,
    pascalCaseName: string
  ) {
    // Domain information
    new ssm.StringParameter(this, 'DomainNameParameter', {
      parameterName: `/${pascalCaseName}/Identity/ActiveDirectoryDomainName`,
      stringValue: domainName,
      description: 'Active Directory Domain Name',
    });

    new ssm.StringParameter(this, 'DirectoryIdParameter', {
      parameterName: `/${pascalCaseName}/Identity/ActiveDirectoryId`,
      stringValue: this.managedAd.ref,
      description: 'AWS Managed AD Directory ID',
    });

    new ssm.StringParameter(this, 'ServerIP1Parameter', {
      parameterName: `/${pascalCaseName}/Identity/ActiveDirectoryServerIP1`,
      stringValue: cdk.Fn.select(0, this.managedAd.attrDnsIpAddresses),
      description: 'Active Directory Server IP 1',
    });

    new ssm.StringParameter(this, 'ServerIP2Parameter', {
      parameterName: `/${pascalCaseName}/Identity/ActiveDirectoryServerIP2`,
      stringValue: cdk.Fn.select(1, this.managedAd.attrDnsIpAddresses),
      description: 'Active Directory Server IP 2',
    });
  }

  private createAdUsers(
    resourceAdminSecret: secretsmanager.Secret,
    adConnectorSecret: secretsmanager.Secret,
    userTableName: string,
    pascalCaseName: string,
    encryptionKey?: kms.IKey
  ) {
    // Create Lambda function for AD user management
    const adUserManagerFunction = new lambda.Function(this, 'AdUserManagerFunction', {
      functionName: `${this.acronym.toLowerCase()}-ad-user-manager`,
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.lambda_handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../../lambda/ad-user-manager')),
      timeout: cdk.Duration.minutes(5),
      reservedConcurrentExecutions: 5,
      environmentEncryption: encryptionKey,
      environment: {
        DIRECTORY_ID: this.managedAd.ref,
        USER_TABLE_NAME: userTableName,
        PASCAL_CASE_NAME: pascalCaseName,
      },
    });

    // Grant permissions to manage AD users and read secrets
    adUserManagerFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        // Directory Service Data API permissions
        'ds-data:CreateUser',
        'ds-data:DeleteUser',
        'ds-data:DescribeUser',
        'ds-data:UpdateUser',
        'ds-data:AddGroupMember',
        'ds-data:RemoveGroupMember',
        // Directory Service permissions for password reset and data access
        'ds:ResetUserPassword',
        'ds:DescribeDirectories',
        'ds:AccessDSData',
        // Secrets Manager permissions
        'secretsmanager:GetSecretValue',
        // DynamoDB permissions
        'dynamodb:PutItem',
        'dynamodb:DeleteItem',
        // SSM permissions to read domain name
        'ssm:GetParameter',
      ],
      resources: [
        `arn:aws:ds:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:directory/${this.managedAd.ref}`,
        resourceAdminSecret.secretArn,
        adConnectorSecret.secretArn,
        `arn:aws:dynamodb:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:table/${userTableName}`,
        `arn:aws:ssm:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:parameter/${pascalCaseName}/Identity/ActiveDirectoryDomainName`,
      ],
    }));

    // Grant KMS decrypt permission for secrets encrypted with customer-managed key
    if (encryptionKey) {
      encryptionKey.grantDecrypt(adUserManagerFunction);
    }

    // Create Custom Resource provider
    const provider = new cr.Provider(this, 'AdUserProvider', {
      onEventHandler: adUserManagerFunction,
    });

    // Create ResourceAdmin user (admin)
    new cdk.CustomResource(this, 'ResourceAdminUser', {
      serviceToken: provider.serviceToken,
      properties: {
        DirectoryId: this.managedAd.ref,
        Username: 'ResourceAdmin',
        SecretArn: resourceAdminSecret.secretArn,
        IsAdmin: 'true',
        Version: '10', // Force re-execution to create users with KMS fix
      },
    });

    // Create AdConnectorUser (service account)
    new cdk.CustomResource(this, 'AdConnectorUser', {
      serviceToken: provider.serviceToken,
      properties: {
        DirectoryId: this.managedAd.ref,
        Username: 'RM_AdConnectorUser',
        SecretArn: adConnectorSecret.secretArn,
        IsAdmin: 'false',
        Version: '10', // Force re-execution to create users with KMS fix
      },
    });
  }

  private createDnsResolver(domainName: string, vpc: ec2.IVpc, privateSubnets: ec2.ISubnet[], pascalCaseName: string) {
    // Create security group for Route 53 resolver
    const resolverSecurityGroup = new ec2.SecurityGroup(this, 'ResolverSecurityGroup', {
      vpc: vpc,
      securityGroupName: `${pascalCaseName}-DNS-Resolver-SG`,
      description: 'Security group for Route 53 resolver endpoint',
      allowAllOutbound: false,
    });

    // Allow DNS traffic (TCP and UDP port 53) to AD servers
    resolverSecurityGroup.addEgressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(53),
      'Allow TCP port 53 for DNS'
    );

    resolverSecurityGroup.addEgressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.udp(53),
      'Allow UDP port 53 for DNS'
    );

    // Create Route 53 resolver endpoint (outbound)
    const resolverEndpoint = new route53resolver.CfnResolverEndpoint(this, 'ResolverEndpoint', {
      direction: 'OUTBOUND',
      ipAddresses: [
        {
          subnetId: privateSubnets[0].subnetId,
        },
        {
          subnetId: privateSubnets[1].subnetId,
        },
      ],
      securityGroupIds: [resolverSecurityGroup.securityGroupId],
    });

    // Create resolver rule to forward AD domain queries to AD DNS servers
    const resolverRule = new route53resolver.CfnResolverRule(this, 'ResolverRule', {
      domainName: domainName,
      ruleType: 'FORWARD',
      resolverEndpointId: resolverEndpoint.ref,
      targetIps: [
        {
          ip: cdk.Fn.select(0, this.managedAd.attrDnsIpAddresses),
        },
        {
          ip: cdk.Fn.select(1, this.managedAd.attrDnsIpAddresses),
        },
      ],
    });

    // Associate the resolver rule with the VPC
    new route53resolver.CfnResolverRuleAssociation(this, 'ResolverRuleAssociation', {
      resolverRuleId: resolverRule.ref,
      vpcId: vpc.vpcId,
    });
  }
}
