// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import { Construct } from 'constructs';

export interface AuthConstructProps {
  pascalCaseName: string;
  acronym: string;
  productName?: string;
  encryptionKey?: kms.IKey;
  adminGroupName?: string;
  frontendUrl?: string;
  adminEmails?: string;
  /** Optional: ARN of an external SSO User Pool to import instead of creating one */
  ssoUserPoolArn?: string;
  /** Optional: Client ID of the external SSO User Pool */
  ssoUserPoolClientId?: string;
  /** Optional: Domain URL of the external SSO User Pool */
  ssoUserPoolDomain?: string;
}

export class AuthConstruct extends Construct {
  public readonly ldapLayer: lambda.LayerVersion;
  public readonly userPool: cognito.IUserPool;
  public readonly userPoolClient: cognito.IUserPoolClient;
  public readonly userPoolDomain: cognito.UserPoolDomain | undefined;
  public readonly identityPool: cognito.CfnIdentityPool;
  public readonly authenticatedRole: iam.Role;
  /** True when using an externally-managed SSO User Pool */
  public readonly isExternalSsoPool: boolean;

  constructor(scope: Construct, id: string, props: AuthConstructProps) {
    super(scope, id);

    const useExternalSso = !!(props.ssoUserPoolArn && props.ssoUserPoolClientId);
    this.isExternalSsoPool = useExternalSso;

    if (useExternalSso) {
      // ─── Import external SSO User Pool ───────────────────────────────────
      // The customer (e.g., AMC Networks) creates a Cognito User Pool with
      // Entra ID SAML integration via their own CloudFormation stack, then
      // hands us the ARN and Client ID to import here.
      this.userPool = cognito.UserPool.fromUserPoolArn(this, 'ImportedUserPool', props.ssoUserPoolArn!);
      
      this.userPoolClient = cognito.UserPoolClient.fromUserPoolClientId(
        this, 'ImportedUserPoolClient', props.ssoUserPoolClientId!
      );

      // No domain created — it's managed externally
      this.userPoolDomain = undefined;

      // Store the SSO domain in SSM — use the same logical ID as the local pool path
      // ('CognitoDomainParameter') so CloudFormation treats this as an update to the
      // existing resource rather than a new one conflicting with the same SSM path.
      if (props.ssoUserPoolDomain) {
        new ssm.StringParameter(this, 'CognitoDomainParameter', {
          parameterName: `/${props.pascalCaseName}/Auth/CognitoDomain`,
          stringValue: props.ssoUserPoolDomain,
          description: 'External SSO Cognito Domain URL',
        });
      }

      // Store Cognito values in SSM parameters — same logical IDs as the local pool path
      new ssm.StringParameter(this, 'UserPoolIdParameter', {
        parameterName: `/${props.pascalCaseName}/Auth/UserPoolId`,
        stringValue: this.userPool.userPoolId,
        description: 'Cognito User Pool ID (external SSO)',
      });

      new ssm.StringParameter(this, 'UserPoolClientIdParameter', {
        parameterName: `/${props.pascalCaseName}/Auth/UserPoolClientId`,
        stringValue: props.ssoUserPoolClientId!,
        description: 'Cognito User Pool Client ID (external SSO)',
      });

      // Identity Pool still created locally — it provides AWS credentials for S3 access
      this.identityPool = new cognito.CfnIdentityPool(this, 'IdentityPool', {
        identityPoolName: `${props.acronym}IdentityPool`,
        allowUnauthenticatedIdentities: false,
        cognitoIdentityProviders: [{
          clientId: props.ssoUserPoolClientId!,
          providerName: `cognito-idp.${cdk.Stack.of(this).region}.amazonaws.com/${this.userPool.userPoolId}`,
        }],
      });

      // IAM role for authenticated users
      this.authenticatedRole = new iam.Role(this, 'AuthenticatedRole', {
        roleName: `${props.acronym}-Cognito-Authenticated-Role`,
        assumedBy: new iam.FederatedPrincipal(
          'cognito-identity.amazonaws.com',
          {
            StringEquals: {
              'cognito-identity.amazonaws.com:aud': this.identityPool.ref,
            },
            'ForAnyValue:StringLike': {
              'cognito-identity.amazonaws.com:amr': 'authenticated',
            },
          },
          'sts:AssumeRoleWithWebIdentity'
        ),
        description: 'Role for authenticated Cognito users to access AWS services',
      });

      // Attach the authenticated role to the identity pool
      new cognito.CfnIdentityPoolRoleAttachment(this, 'IdentityPoolRoleAttachment', {
        identityPoolId: this.identityPool.ref,
        roles: {
          authenticated: this.authenticatedRole.roleArn,
        },
      });

      // Store Identity Pool ID in SSM
      new ssm.StringParameter(this, 'IdentityPoolIdParameter', {
        parameterName: `/${props.pascalCaseName}/Auth/IdentityPoolId`,
        stringValue: this.identityPool.ref,
        description: 'Cognito Identity Pool ID for direct AWS service access',
      });

      // LDAP Layer (still needed for workstation auth regardless of SSO mode)
      this.ldapLayer = new lambda.LayerVersion(this, 'LdapLayer', {
        code: lambda.Code.fromAsset('layers/ldap'),
        compatibleRuntimes: [lambda.Runtime.NODEJS_22_X],
        description: 'LDAP client library for authentication',
      });

      new ssm.StringParameter(this, 'LdapLayerArnParameter', {
        parameterName: `/${props.pascalCaseName}/Auth/LdapLayerArn`,
        stringValue: this.ldapLayer.layerVersionArn,
        description: 'LDAP Layer ARN for workstation authentication',
      });

      return; // Skip the rest — no local pool creation needed
    }

    // ─── Create local Cognito User Pool (default behavior) ─────────────────

    // Use placeholder URLs for initial deployment - the PreserveSamlProviders Lambda
    // will read the actual frontend URL from SSM at runtime and update the client
    const placeholderUrl = 'https://placeholder.cloudfront.net';
    const callbackUrls = [placeholderUrl, `${placeholderUrl}/`, 'http://localhost:3000', 'http://localhost:3000/'];
    const logoutUrls = [placeholderUrl, `${placeholderUrl}/`, 'http://localhost:3000', 'http://localhost:3000/'];

    // Define custom attributes.
    // NOTE: Cognito does not allow removing or modifying existing custom attributes.
    // All attributes that have ever been added to this User Pool must remain here,
    // even if they are no longer actively used, or CDK will fail with:
    // "Existing schema attributes cannot be modified or deleted."
    const customAttributes: { [key: string]: cognito.ICustomAttribute } = {
      department: new cognito.StringAttribute({ mutable: true }),
      isAdmin: new cognito.StringAttribute({ mutable: true }),
      groups: new cognito.StringAttribute({ mutable: true }),
      posix: new cognito.StringAttribute({ mutable: true }),
      ldap: new cognito.StringAttribute({ mutable: true }),
    };

    // Cognito User Pool for SAML authentication
    const loginUrl = props.frontendUrl || 'your CloudFront URL (check deployment outputs)';
    const displayName = props.productName || props.pascalCaseName;
    this.userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: `${props.acronym}-UserPool`,
      signInAliases: { email: true },
      standardAttributes: {
        email: { required: true, mutable: true },
        givenName: { required: true, mutable: true },
        familyName: { required: true, mutable: true },
      },
      customAttributes,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      userInvitation: {
        emailSubject: `You're invited to ${displayName}`,
        emailBody: `<p>Hello,</p>
<p>You have been granted admin access to <strong>${displayName}</strong>.</p>
<p><strong>Login URL:</strong> <a href="${loginUrl}">${loginUrl}</a><br/>
<strong>Username:</strong> {username}<br/>
<strong>Temporary Password:</strong> {####}</p>
<p>You will be prompted to set a new password on first login.</p>`,
      },
    });

    // Pre Token Generation Lambda trigger
    // Maps SAML group claims (from custom:groups attribute) into cognito:groups
    // so the frontend can check group membership for admin access using display names
    const preTokenGenerationFn = new lambda.Function(this, 'PreTokenGenerationFunction', {
      functionName: `${props.acronym.toLowerCase()}-pre-token-generation`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/pre-token-generation'),
      timeout: cdk.Duration.seconds(5),
      reservedConcurrentExecutions: 10,
      environmentEncryption: props.encryptionKey,
    });

    (this.userPool as cognito.UserPool).addTrigger(cognito.UserPoolOperation.PRE_TOKEN_GENERATION, preTokenGenerationFn);

    // Configure supported identity providers
    const supportedIdentityProviders: cognito.UserPoolClientIdentityProvider[] = [
      cognito.UserPoolClientIdentityProvider.COGNITO,
    ];

    this.userPoolClient = new cognito.UserPoolClient(this, 'UserPoolClient', {
      userPool: this.userPool,
      generateSecret: false,
      authFlows: { userSrp: true, adminUserPassword: true, userPassword: true },
      supportedIdentityProviders,
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.EMAIL, cognito.OAuthScope.OPENID, cognito.OAuthScope.PROFILE],
        callbackUrls: callbackUrls,
        logoutUrls: logoutUrls,
      },
    });

    this.userPoolDomain = new cognito.UserPoolDomain(this, 'UserPoolDomain', {
      userPool: this.userPool,
      cognitoDomain: { domainPrefix: `${props.acronym.toLowerCase()}-${cdk.Stack.of(this).account.substring(0,8)}` },
    });

    // Cognito Identity Pool for direct AWS service access (S3 Storage Browser, S3 Watchfolder app)
    // This allows authenticated users to get temporary AWS credentials scoped to specific resources
    this.identityPool = new cognito.CfnIdentityPool(this, 'IdentityPool', {
      identityPoolName: `${props.acronym}IdentityPool`,
      allowUnauthenticatedIdentities: false,
      cognitoIdentityProviders: [{
        clientId: this.userPoolClient.userPoolClientId,
        providerName: this.userPool.userPoolProviderName,
      }],
    });

    // IAM role for authenticated users - grants access to media bucket
    // The actual S3 bucket permissions will be added by the storage stack
    this.authenticatedRole = new iam.Role(this, 'AuthenticatedRole', {
      roleName: `${props.acronym}-Cognito-Authenticated-Role`,
      assumedBy: new iam.FederatedPrincipal(
        'cognito-identity.amazonaws.com',
        {
          StringEquals: {
            'cognito-identity.amazonaws.com:aud': this.identityPool.ref,
          },
          'ForAnyValue:StringLike': {
            'cognito-identity.amazonaws.com:amr': 'authenticated',
          },
        },
        'sts:AssumeRoleWithWebIdentity'
      ),
      description: 'Role for authenticated Cognito users to access AWS services',
    });

    // Attach the authenticated role to the identity pool
    new cognito.CfnIdentityPoolRoleAttachment(this, 'IdentityPoolRoleAttachment', {
      identityPoolId: this.identityPool.ref,
      roles: {
        authenticated: this.authenticatedRole.roleArn,
      },
    });

    // Store Identity Pool ID in SSM for frontend config and S3 Watchfolder app
    new ssm.StringParameter(this, 'IdentityPoolIdParameter', {
      parameterName: `/${props.pascalCaseName}/Auth/IdentityPoolId`,
      stringValue: this.identityPool.ref,
      description: 'Cognito Identity Pool ID for direct AWS service access',
    });

    // Custom Resource to preserve SAML identity providers after deployment
    // SAML providers (Okta, IdentityCenter) are created via CLI scripts, but CDK
    // resets supportedIdentityProviders to just COGNITO. This custom resource
    // lists existing providers and updates the client to include them.
    // It also reads the frontend URL from SSM to set correct callback URLs.
    const frontendUrlParamName = `/${props.pascalCaseName}/Frontend/Url`;
    
    const preserveSamlProvidersLambda = new lambda.Function(this, 'PreserveSamlProvidersLambda', {
      functionName: `${props.acronym.toLowerCase()}-preserve-saml-providers`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/preserve-saml-providers'),
      timeout: cdk.Duration.seconds(30),
      reservedConcurrentExecutions: 5,
      environmentEncryption: props.encryptionKey,
      environment: {
        USER_POOL_ID: this.userPool.userPoolId,
        CLIENT_ID: this.userPoolClient.userPoolClientId,
        FRONTEND_URL_PARAM_NAME: frontendUrlParamName,
      },
    });

    preserveSamlProvidersLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'cognito-idp:ListIdentityProviders',
        'cognito-idp:UpdateUserPoolClient',
      ],
      resources: [
        this.userPool.userPoolArn,
        `${this.userPool.userPoolArn}/client/*`,
      ],
    }));
    
    // Allow Lambda to read the frontend URL from SSM
    preserveSamlProvidersLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter'],
      resources: [`arn:aws:ssm:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:parameter${frontendUrlParamName}`],
    }));

    const preserveSamlProviders = new cdk.CustomResource(this, 'PreserveSamlProviders', {
      serviceToken: preserveSamlProvidersLambda.functionArn,
      properties: {
        // Force update on each deployment to preserve SAML providers that CDK resets
        Timestamp: Date.now().toString(),
      },
    });
    preserveSamlProviders.node.addDependency(this.userPoolClient);

    // Store Cognito values in SSM parameters
    new ssm.StringParameter(this, 'UserPoolIdParameter', {
      parameterName: `/${props.pascalCaseName}/Auth/UserPoolId`,
      stringValue: this.userPool.userPoolId,
      description: 'Cognito User Pool ID'
    });

    new ssm.StringParameter(this, 'UserPoolClientIdParameter', {
      parameterName: `/${props.pascalCaseName}/Auth/UserPoolClientId`,
      stringValue: this.userPoolClient.userPoolClientId,
      description: 'Cognito User Pool Client ID'
    });

    new ssm.StringParameter(this, 'CognitoDomainParameter', {
      parameterName: `/${props.pascalCaseName}/Auth/CognitoDomain`,
      stringValue: `https://${this.userPoolDomain.domainName}.auth.${cdk.Stack.of(this).region}.amazoncognito.com`,
      description: 'Cognito Domain URL'
    });

    // Note: Okta SAML Identity Provider created manually via CLI

    // LDAP Layer for Lambda functions (existing)
    this.ldapLayer = new lambda.LayerVersion(this, 'LdapLayer', {
      code: lambda.Code.fromAsset('layers/ldap'),
      compatibleRuntimes: [lambda.Runtime.NODEJS_22_X],
      description: 'LDAP client library for authentication',
    });

    // Store LDAP Layer ARN in SSM parameter for reference
    new ssm.StringParameter(this, 'LdapLayerArnParameter', {
      parameterName: `/${props.pascalCaseName}/Auth/LdapLayerArn`,
      stringValue: this.ldapLayer.layerVersionArn,
      description: 'LDAP Layer ARN for workstation authentication'
    });

    // Auto-create admin group(s) and initial admin users in Cognito User Pool
    // AdminGroupName can be comma-separated (e.g., "MRM-Admins,14b814d8-...,us-east-1_xxx_Okta")
    // Only create groups that look like simple Cognito group names.
    // Skip UUIDs (Identity Center group IDs) and IdP-prefixed names (federated groups).
    // AdminEmails creates Cognito users and adds them to the first admin group.
    // Uses a custom resource — idempotent (skips existing groups and users).
    const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
    const isIdpPrefixed = (s: string) => /^[a-z]+-[a-z0-9]+_[a-zA-Z0-9]+_/.test(s);

    const allGroups = (props.adminGroupName || '').split(',').map(g => g.trim()).filter(g => g);
    const cognitoGroups = allGroups.filter(g => !isUuid(g) && !isIdpPrefixed(g));
    const adminEmails = (props.adminEmails || '').split(',').map(e => e.trim()).filter(e => e);

    if (cognitoGroups.length > 0 || adminEmails.length > 0) {
      const adminSetupFn = new lambda.Function(this, 'CreateAdminGroupsFunction', {
        functionName: `${props.acronym.toLowerCase()}-create-admin-groups`,
        runtime: lambda.Runtime.NODEJS_22_X,
        handler: 'index.handler',
        timeout: cdk.Duration.seconds(30),
        reservedConcurrentExecutions: 1,
        environmentEncryption: props.encryptionKey,
        code: lambda.Code.fromAsset('lambda/create-admin-groups'),
      });

      adminSetupFn.addToRolePolicy(new iam.PolicyStatement({
        actions: [
          'cognito-idp:CreateGroup',
          'cognito-idp:AdminCreateUser',
          'cognito-idp:AdminGetUser',
          'cognito-idp:AdminAddUserToGroup',
        ],
        resources: [this.userPool.userPoolArn],
      }));

      new cdk.CustomResource(this, 'AdminSetup', {
        serviceToken: adminSetupFn.functionArn,
        properties: {
          UserPoolId: this.userPool.userPoolId,
          Groups: JSON.stringify(cognitoGroups),
          AdminEmails: JSON.stringify(adminEmails),
        },
      });
    }
  }
}
