// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import { Construct } from 'constructs';

export interface FrontendStackProps extends cdk.StackProps {
  productName: string;
  pascalCaseName: string;
  acronym: string;
  apiUrl?: string;
  dataEncryptionKey?: kms.IKey;
  userTableName?: string;
  workstationTableName?: string;
  frontendUrl?: string;
  frontendCertificateArn?: string;
  enableBedrockFeatures?: boolean;
  webAclArn?: string;
}

export class FrontendStack extends cdk.Stack {
  public readonly websiteBucket: s3.Bucket;
  public readonly logsBucket: s3.Bucket;
  public readonly distribution: cloudfront.Distribution;
  public readonly configGeneratorFunction: lambda.Function;

  constructor(scope: Construct, id: string, props: FrontendStackProps) {
    super(scope, id, {
      ...props,
      description: "React web application hosted on S3 with CloudFront distribution for workstation management"
    });

    // S3 bucket for access logs (CKV_AWS_18)
    this.logsBucket = new s3.Bucket(this, 'LogsBucket', {
      bucketName: `${props.acronym.toLowerCase()}-logs-${this.account}-${this.region}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      lifecycleRules: [
        {
          id: 'DeleteOldLogs',
          expiration: cdk.Duration.days(90),
          noncurrentVersionExpiration: cdk.Duration.days(30),
        }
      ],
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // S3 bucket for static website (private) - CKV_AWS_18, CKV_AWS_21
    this.websiteBucket = new s3.Bucket(this, 'WebsiteBucket', {
      bucketName: `${props.acronym.toLowerCase()}-frontend-${this.account}-${this.region}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      serverAccessLogsBucket: this.logsBucket,
      serverAccessLogsPrefix: 'frontend-access-logs/',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // Origin Access Identity for CloudFront
    const oai = new cloudfront.OriginAccessIdentity(this, 'OAI', {
      comment: 'OAI for workstation management frontend',
    });

    // Grant CloudFront access to the bucket
    this.websiteBucket.grantRead(oai);

    // CloudFront distribution
    // Configure custom domain + certificate if FrontendUrl and certificate ARN are provided
    const customDomain = props.frontendUrl
      ? new URL(props.frontendUrl).hostname
      : undefined;
    const certificate = props.frontendCertificateArn
      ? acm.Certificate.fromCertificateArn(this, 'FrontendCertificate', props.frontendCertificateArn)
      : undefined;

    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessIdentity(this.websiteBucket, {
          originAccessIdentity: oai,
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD,
      },
      defaultRootObject: 'index.html',
      // WAF WebACL ARN from the WafStack (deployed in us-east-1)
      ...(props.webAclArn ? { webAclId: props.webAclArn } : {}),
      // Custom domain alias + ACM certificate (must be in us-east-1)
      ...(customDomain && certificate ? {
        domainNames: [customDomain],
        certificate,
        minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      } : {}),
      errorResponses: [
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
        },
      ],
    });

    // Create Lambda function to generate config.json at deployment time
    this.configGeneratorFunction = new lambda.Function(this, 'ConfigGenerator', {
      functionName: `${props.acronym.toLowerCase()}-config-generator`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('./lambda/config-generator'),
      timeout: cdk.Duration.minutes(5),
      reservedConcurrentExecutions: 5,
      environmentEncryption: props.dataEncryptionKey,
      environment: {
        PRODUCT_NAME: props.productName,
        PRODUCT_ACRONYM: props.acronym,
        PASCAL_CASE_NAME: props.pascalCaseName,
        BUCKET_NAME: this.websiteBucket.bucketName,
        USER_TABLE_NAME: props.userTableName || 'workstation-users',
        WORKSTATION_TABLE_NAME: props.workstationTableName || 'workstation-instances',
        ENABLE_BEDROCK_FEATURES: props.enableBedrockFeatures !== false ? 'true' : 'false',
      },
    });

    // Grant S3 write permissions to the Lambda
    this.websiteBucket.grantWrite(this.configGeneratorFunction);
    
    // Grant SSM read permissions to the Lambda
    this.configGeneratorFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['ssm:GetParameter'],
      resources: [
        `arn:aws:ssm:${this.region}:${this.account}:parameter/${props.pascalCaseName}/Workstation/ApiUrl`,
        `arn:aws:ssm:${this.region}:${this.account}:parameter/${props.pascalCaseName}/Auth/*`,
        `arn:aws:ssm:${this.region}:${this.account}:parameter/${props.pascalCaseName}/Storage/*`,
      ],
    }));
    
    // Grant Cognito permissions to list identity providers
    this.configGeneratorFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['cognito-idp:ListIdentityProviders'],
      resources: [`arn:aws:cognito-idp:${this.region}:${this.account}:userpool/*`],
    }));

    // Deploy frontend files (without config.json since it's generated by Lambda)
    const bucketDeployment = new s3deploy.BucketDeployment(this, 'DeployWebsite', {
      sources: [
        s3deploy.Source.asset('./frontend/dist'),
      ],
      destinationBucket: this.websiteBucket,
      distribution: this.distribution,
      distributionPaths: ['/*'],
      memoryLimit: 512,
      // Don't wait for CloudFront invalidation to complete — avoids Lambda timeout
      // on slow invalidations (https://github.com/aws/aws-cdk/issues/15891)
      waitForDistributionInvalidation: false,
    });

    // Create custom resource to trigger config generation AFTER bucket deployment
    const configGenerator = new cr.Provider(this, 'ConfigGeneratorProvider', {
      onEventHandler: this.configGeneratorFunction,
    });

    const configResource = new cdk.CustomResource(this, 'ConfigGeneratorResource', {
      serviceToken: configGenerator.serviceToken,
      properties: {
        BucketName: this.websiteBucket.bucketName,
        Timestamp: Date.now().toString(), // Force regeneration on every deploy
      },
    });

    // Ensure config is generated after bucket deployment
    configResource.node.addDependency(bucketDeployment);

    // Outputs
    // Update CloudFront URL in existing SSM parameter (created by Main stack as placeholder)
    const updateParameterFunction = new lambda.Function(this, 'UpdateParameterFunction', {
      functionName: `${props.acronym.toLowerCase()}-update-parameter`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('./lambda/update-parameter'),
      timeout: cdk.Duration.seconds(30),
      reservedConcurrentExecutions: 5,
      environmentEncryption: props.dataEncryptionKey,
      environment: {
        PASCAL_CASE_NAME: props.pascalCaseName,
      },
    });

    updateParameterFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['ssm:PutParameter'],
      resources: [
        `arn:aws:ssm:${this.region}:${this.account}:parameter/${props.pascalCaseName}/Frontend/Url`,
        `arn:aws:ssm:${this.region}:${this.account}:parameter/${props.pascalCaseName}/Frontend/ConfigGeneratorArn`,
      ],
    }));

    const updateParameterProvider = new cr.Provider(this, 'UpdateParameterProvider', {
      onEventHandler: updateParameterFunction,
    });

    new cdk.CustomResource(this, 'UpdateFrontendUrlParameter', {
      serviceToken: updateParameterProvider.serviceToken,
      properties: {
        CloudFrontUrl: `https://${this.distribution.distributionDomainName}`,
        CustomFrontendUrl: props.frontendUrl || '',
      },
    });

    // Store config generator Lambda ARN in SSM for scripts to use
    new ssm.StringParameter(this, 'ConfigGeneratorArnParameter', {
      parameterName: `/${props.pascalCaseName}/Frontend/ConfigGeneratorArn`,
      stringValue: this.configGeneratorFunction.functionArn,
      description: 'ARN of the config generator Lambda function',
    });

    new cdk.CfnOutput(this, 'WebsiteUrl', {
      value: `https://${this.distribution.distributionDomainName}`,
      description: 'Workstation Management Console URL',
    });

    new cdk.CfnOutput(this, 'WebsiteBucketName', {
      value: this.websiteBucket.bucketName,
      description: 'S3 bucket name for frontend',
    });
  }
}
