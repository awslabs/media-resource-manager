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

/**
 * Configuration for `adMode === 'connector'`: MRM will provision an AWS AD
 * Connector directory that proxies to the customer's existing Active
 * Directory. The customer is responsible for creating the service account
 * inside their AD (with the delegated permissions AD Connector requires) and
 * storing its credentials in Secrets Manager.
 */
export interface AdConnectorConfig {
  /** FQDN of the customer AD (e.g. "customer.internal"). */
  domainName: string;
  /** 1-4 DC IPs reachable from the MRM VPC. */
  dnsServerIps: string[];
  /**
   * ARN of a Secrets Manager secret containing `{"username": "...",
   * "password": "..."}` for the AD Connector service account. The secret
   * must live in the same account/region as MRM.
   */
  serviceAccountSecretArn: string;
  /** 'Small' (default) or 'Large'. */
  size?: 'Small' | 'Large';
  /** Optional NetBIOS name; auto-derived from the domain if omitted. */
  netbiosName?: string;
  /** Human-readable description shown in the Directory Service console. */
  description?: string;
}

export interface IdentityConstructProps {
  vpc: ec2.IVpc;
  privateSubnets: ec2.ISubnet[];
  pascalCaseName: string;
  acronym: string;
  userTableName: string;
  encryptionKey?: kms.IKey;
  /**
   * AD provisioning mode. `'managed'` (default) creates AWS Managed
   * Microsoft AD in the MRM account; `'connector'` provisions an AD
   * Connector against a customer-supplied AD. See issue #27 (BYO-AD).
   */
  adMode?: 'managed' | 'connector';
  /**
   * Required and only meaningful when `adMode === 'connector'`.
   */
  adConnectorConfig?: AdConnectorConfig;
}

/**
 * Identity layer for MRM.
 *
 * When `adMode === 'managed'` (default): creates AWS Managed Microsoft AD
 * plus MRM-managed service accounts (`ResourceAdmin`, `RM_AdConnectorUser`)
 * inside it. Byte-identical to the pre-PR-3 behavior.
 *
 * When `adMode === 'connector'`: creates an AWS AD Connector pointing at a
 * customer-supplied AD, using a customer-supplied Secrets Manager secret for
 * the AD Connector service account credentials. No user objects are created
 * in the customer's AD.
 *
 * Both modes expose the same downstream surface:
 *   • `directoryId` (CFN token)
 *   • Route 53 Resolver rule forwarding the AD domain to the right DNS IPs
 *   • SSM parameters under `/${pascalCaseName}/Identity/`:
 *       - ActiveDirectoryDomainName
 *       - ActiveDirectoryId
 *       - ActiveDirectoryServerIP1
 *       - ActiveDirectoryServerIP2
 *       - AdServiceAccountSecretArn      (new in PR 3 — mode-agnostic)
 */
export class IdentityConstruct extends Construct {
  /** The Managed AD resource (only populated when `adMode === 'managed'`). */
  public readonly managedAd?: ds.CfnMicrosoftAD;
  /** DirectoryId as a CFN token, populated in both modes. */
  public readonly directoryId: string;
  /**
   * ARN of the AD service-account secret (MRM-managed in `'managed'` mode,
   * customer-supplied in `'connector'` mode). Downstream code should prefer
   * reading this from SSM (`/Identity/AdServiceAccountSecretArn`) rather
   * than referencing this property, so the same code path works for both
   * modes.
   */
  public readonly serviceAccountSecretArn: string;

  private readonly pascalCaseName: string;
  private readonly acronym: string;

  constructor(scope: Construct, id: string, props: IdentityConstructProps) {
    super(scope, id);

    this.pascalCaseName = props.pascalCaseName;
    this.acronym = props.acronym;

    const adMode = props.adMode ?? 'managed';
    const params = this.loadParameters();

    // Domain name comes from different sources depending on mode. In managed
    // mode it's parameters.json (or falls back to the demo default). In
    // connector mode it must come from the connector config (customer input).
    let domainName: string;
    let dnsIps: string[];
    let serviceAccountSecretArn: string;

    if (adMode === 'connector') {
      if (!props.adConnectorConfig) {
        throw new Error(
          "IdentityConstruct: adMode='connector' requires adConnectorConfig " +
          '(domainName, dnsServerIps, serviceAccountSecretArn).'
        );
      }
      const cfg = props.adConnectorConfig;

      if (!cfg.domainName) {
        throw new Error("adConnectorConfig.domainName is required when adMode='connector'");
      }
      if (!cfg.dnsServerIps || cfg.dnsServerIps.length < 1 || cfg.dnsServerIps.length > 4) {
        throw new Error(
          "adConnectorConfig.dnsServerIps must be a list of 1-4 DC IPs " +
          `when adMode='connector' (got ${cfg.dnsServerIps?.length ?? 0}).`
        );
      }
      if (!cfg.serviceAccountSecretArn) {
        throw new Error("adConnectorConfig.serviceAccountSecretArn is required when adMode='connector'");
      }

      domainName = cfg.domainName;

      // Provision AD Connector via a Custom Resource. Returns DirectoryId as
      // an attribute we can reference downstream.
      const connectorProps = this.createAdConnector(
        cfg,
        props.vpc,
        props.privateSubnets,
        props.pascalCaseName,
      );
      this.directoryId = connectorProps.directoryId;
      dnsIps = cfg.dnsServerIps;
      serviceAccountSecretArn = cfg.serviceAccountSecretArn;
    } else {
      // ─────── Managed AD path (byte-identical to pre-PR-3 behavior) ───────
      domainName = params.DomainName || 'studio.mrm.internal';

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

      this.directoryId = this.managedAd.ref;
      dnsIps = [
        cdk.Fn.select(0, this.managedAd.attrDnsIpAddresses),
        cdk.Fn.select(1, this.managedAd.attrDnsIpAddresses),
      ];
      // Downstream (DataSync, etc.) has historically looked up the service
      // account secret by its well-known name. Keep that name pointing at the
      // ResourceAdmin secret in managed mode.
      serviceAccountSecretArn = resourceAdminSecret.secretArn;

      // Enable Directory Data Access (Data API) — only relevant for Managed AD.
      this.enableDirectoryDataAccess();

      // Create AD users using Custom Resources — only relevant for Managed AD.
      this.createAdUsers(
        resourceAdminSecret,
        adConnectorSecret,
        props.userTableName,
        props.pascalCaseName,
        props.encryptionKey,
      );

      new cdk.CfnOutput(this, 'ManagedADId', {
        value: this.managedAd.ref,
        description: 'AWS Managed AD Directory ID',
      });
    }

    // ─── Common wiring (both modes) ───

    this.serviceAccountSecretArn = serviceAccountSecretArn;

    // Route 53 Resolver rule forwarding AD-domain DNS queries to the
    // appropriate DC IPs (Managed AD's in managed mode, customer's in
    // connector mode).
    this.createDnsResolver(domainName, props.vpc, props.privateSubnets, props.pascalCaseName, dnsIps);

    // Store parameters in SSM. Same well-known paths in both modes so
    // downstream code doesn't care which mode is active.
    this.createSSMParameters(
      domainName,
      this.directoryId,
      dnsIps,
      serviceAccountSecretArn,
      props.pascalCaseName,
    );

    // Common CFN output for the domain name.
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

  /**
   * Managed-AD-only: enable the Directory Service Data API so subsequent
   * Custom Resources can create/manage users via `ds-data:*`.
   */
  private enableDirectoryDataAccess() {
    if (!this.managedAd) {
      throw new Error('enableDirectoryDataAccess called without a Managed AD');
    }
    const managedAd = this.managedAd;

    const enableDataAccessFunction = new lambda.Function(this, 'EnableDataAccessFunction', {
      functionName: `${this.acronym.toLowerCase()}-enable-directory-data-access`,
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      reservedConcurrentExecutions: 5,
      code: lambda.Code.fromAsset(path.join(__dirname, '../../lambda/enable-directory-data-access')),
      timeout: cdk.Duration.minutes(5),
    });

    enableDataAccessFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['ds:EnableDirectoryDataAccess'],
        resources: [`arn:aws:ds:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:directory/${managedAd.ref}`],
      })
    );

    new cdk.CustomResource(this, 'EnableDirectoryDataAccess', {
      serviceToken: enableDataAccessFunction.functionArn,
      properties: {
        DirectoryId: managedAd.ref,
      },
    });
  }

  /**
   * Managed-AD-only: creates the `ResourceAdmin` (admin) and
   * `RM_AdConnectorUser` (service account) inside Managed AD using the
   * Directory Service Data API. Connector mode is a no-op — MRM never
   * creates users in the customer's AD.
   */
  private createAdUsers(
    resourceAdminSecret: secretsmanager.Secret,
    adConnectorSecret: secretsmanager.Secret,
    userTableName: string,
    pascalCaseName: string,
    encryptionKey?: kms.IKey
  ) {
    if (!this.managedAd) {
      throw new Error('createAdUsers called without a Managed AD');
    }
    const managedAd = this.managedAd;

    const adUserManagerFunction = new lambda.Function(this, 'AdUserManagerFunction', {
      functionName: `${this.acronym.toLowerCase()}-ad-user-manager`,
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.lambda_handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../../lambda/ad-user-manager')),
      timeout: cdk.Duration.minutes(5),
      reservedConcurrentExecutions: 5,
      environmentEncryption: encryptionKey,
      environment: {
        DIRECTORY_ID: managedAd.ref,
        USER_TABLE_NAME: userTableName,
        PASCAL_CASE_NAME: pascalCaseName,
      },
    });

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
        `arn:aws:ds:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:directory/${managedAd.ref}`,
        resourceAdminSecret.secretArn,
        adConnectorSecret.secretArn,
        `arn:aws:dynamodb:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:table/${userTableName}`,
        `arn:aws:ssm:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:parameter/${pascalCaseName}/Identity/ActiveDirectoryDomainName`,
      ],
    }));

    if (encryptionKey) {
      encryptionKey.grantDecrypt(adUserManagerFunction);
    }

    const provider = new cr.Provider(this, 'AdUserProvider', {
      onEventHandler: adUserManagerFunction,
    });

    new cdk.CustomResource(this, 'ResourceAdminUser', {
      serviceToken: provider.serviceToken,
      properties: {
        DirectoryId: managedAd.ref,
        Username: 'ResourceAdmin',
        SecretArn: resourceAdminSecret.secretArn,
        IsAdmin: 'true',
        Version: '10', // Force re-execution to create users with KMS fix
      },
    });

    new cdk.CustomResource(this, 'AdConnectorUser', {
      serviceToken: provider.serviceToken,
      properties: {
        DirectoryId: managedAd.ref,
        Username: 'RM_AdConnectorUser',
        SecretArn: adConnectorSecret.secretArn,
        IsAdmin: 'false',
        Version: '10', // Force re-execution to create users with KMS fix
      },
    });
  }

  /**
   * Connector-mode-only: provision an AWS AD Connector directory that
   * proxies to the customer's AD. Returns the DirectoryId as a CFN token so
   * downstream SSM/DNS wiring can reference it uniformly.
   */
  private createAdConnector(
    cfg: AdConnectorConfig,
    vpc: ec2.IVpc,
    privateSubnets: ec2.ISubnet[],
    pascalCaseName: string,
  ): { directoryId: string } {
    const provisionerFn = new lambda.Function(this, 'AdConnectorProvisionerFunction', {
      functionName: `${this.acronym.toLowerCase()}-ad-connector-provisioner`,
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../../lambda/ad-connector-provisioner')),
      timeout: cdk.Duration.minutes(15), // provisioning typically 3-5 min, poll budget 12 min
      reservedConcurrentExecutions: 5,
    });

    // Directory Service lifecycle permissions.
    provisionerFn.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'ds:ConnectDirectory',
        'ds:DeleteDirectory',
        'ds:DescribeDirectories',
        'ds:AddTagsToResource',
      ],
      resources: ['*'], // ConnectDirectory operates on the AWS account, not a specific ARN
    }));

    // Read customer-supplied secret containing the AD Connector service
    // account credentials.
    provisionerFn.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret'],
      resources: [cfg.serviceAccountSecretArn],
    }));

    // Directory Service needs to attach ENIs to the VPC subnets. Since
    // ds:ConnectDirectory calls this on behalf of the service, no explicit
    // ec2:CreateNetworkInterface permission is needed on our Lambda role.

    // Match the pre-existing convention: use two subnets in different AZs.
    if (privateSubnets.length < 2) {
      throw new Error(
        `AD Connector requires at least 2 private subnets in different AZs, got ${privateSubnets.length}`,
      );
    }
    const subnetIds = [privateSubnets[0].subnetId, privateSubnets[1].subnetId];

    const description = cfg.description
      // Description regex on ConnectDirectory disallows parentheses — see
      // https://docs.aws.amazon.com/directoryservice/latest/APIReference/API_ConnectDirectory.html
      || `MRM AD Connector for ${cfg.domainName} via ${pascalCaseName}`;

    const connector = new cdk.CustomResource(this, 'AdConnectorResource', {
      serviceToken: provisionerFn.functionArn,
      properties: {
        DirectoryName: cfg.domainName,
        NetbiosName: cfg.netbiosName ?? '',
        Size: cfg.size ?? 'Small',
        Description: description,
        VpcId: vpc.vpcId,
        SubnetIds: subnetIds,
        CustomerDnsIps: cfg.dnsServerIps,
        ServiceAccountSecretArn: cfg.serviceAccountSecretArn,
      },
    });

    return { directoryId: connector.getAttString('DirectoryId') };
  }

  private createSSMParameters(
    domainName: string,
    directoryId: string,
    dnsIps: string[],
    serviceAccountSecretArn: string,
    pascalCaseName: string,
  ) {
    // Domain information — same well-known parameter paths in both modes.
    new ssm.StringParameter(this, 'DomainNameParameter', {
      parameterName: `/${pascalCaseName}/Identity/ActiveDirectoryDomainName`,
      stringValue: domainName,
      description: 'Active Directory Domain Name',
    });

    new ssm.StringParameter(this, 'DirectoryIdParameter', {
      parameterName: `/${pascalCaseName}/Identity/ActiveDirectoryId`,
      stringValue: directoryId,
      description: 'Directory Service Directory ID (Managed AD or AD Connector)',
    });

    new ssm.StringParameter(this, 'ServerIP1Parameter', {
      parameterName: `/${pascalCaseName}/Identity/ActiveDirectoryServerIP1`,
      stringValue: dnsIps[0],
      description: 'Active Directory Server IP 1',
    });

    // In connector mode a customer may supply only a single DC IP. Fall back
    // to duplicating the first so downstream consumers that read both params
    // (workstation join scripts, etc.) still resolve to a usable IP.
    new ssm.StringParameter(this, 'ServerIP2Parameter', {
      parameterName: `/${pascalCaseName}/Identity/ActiveDirectoryServerIP2`,
      stringValue: dnsIps[1] ?? dnsIps[0],
      description: 'Active Directory Server IP 2',
    });

    // NEW in PR 3: mode-agnostic pointer to the AD service-account secret.
    // Downstream code should prefer this over hardcoding the well-known name
    // `.../ResourceAdminActiveDirectoryLoginCredentials`, which only exists
    // in managed mode.
    new ssm.StringParameter(this, 'AdServiceAccountSecretArnParameter', {
      parameterName: `/${pascalCaseName}/Identity/AdServiceAccountSecretArn`,
      stringValue: serviceAccountSecretArn,
      description:
        'ARN of the AD service-account secret ({username, password}). Points at '
        + 'the MRM-managed ResourceAdmin secret in adMode=managed, or the '
        + 'customer-supplied secret in adMode=connector.',
    });
  }

  private createDnsResolver(
    domainName: string,
    vpc: ec2.IVpc,
    privateSubnets: ec2.ISubnet[],
    pascalCaseName: string,
    targetDnsIps: string[],
  ) {
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
        { subnetId: privateSubnets[0].subnetId },
        { subnetId: privateSubnets[1].subnetId },
      ],
      securityGroupIds: [resolverSecurityGroup.securityGroupId],
    });

    // Create resolver rule to forward AD domain queries to the DNS targets.
    // Managed-AD mode: two Managed-AD DNS IPs. Connector mode: 1-4 customer
    // DC IPs.
    const resolverRule = new route53resolver.CfnResolverRule(this, 'ResolverRule', {
      domainName: domainName,
      ruleType: 'FORWARD',
      resolverEndpointId: resolverEndpoint.ref,
      targetIps: targetDnsIps.map(ip => ({ ip })),
    });

    // Associate the resolver rule with the VPC
    new route53resolver.CfnResolverRuleAssociation(this, 'ResolverRuleAssociation', {
      resolverRuleId: resolverRule.ref,
      vpcId: vpc.vpcId,
    });
  }
}
