// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import { Construct } from 'constructs';

export interface WafStackProps extends cdk.StackProps {
  productName: string;
  pascalCaseName: string;
  wafAllowedIps?: string[];
}

/**
 * WAF stack for CloudFront protection.
 * Must be deployed in us-east-1 (AWS requirement for CloudFront-scoped WAF).
 * 
 * Always includes AWS Managed Rules for common web attack protection.
 * Optionally IP-restricts access when wafAllowedIps is provided.
 */
export class WafStack extends cdk.Stack {
  public readonly webAclArn: string;

  constructor(scope: Construct, id: string, props: WafStackProps) {
    super(scope, id, {
      ...props,
      crossRegionReferences: true,
      description: 'WAF WebACL for CloudFront protection (must be in us-east-1)',
    });

    const hasIpWhitelist = props.wafAllowedIps && props.wafAllowedIps.length > 0;
    const rules: wafv2.CfnWebACL.RuleProperty[] = [];
    let ruleIndex = 0;

    // IP whitelist rules (only when wafAllowedIps is set)
    if (hasIpWhitelist) {
      const ipv4Addresses = props.wafAllowedIps!.filter(ip => !ip.includes(':'));
      const ipv6Addresses = props.wafAllowedIps!.filter(ip => ip.includes(':'));

      if (ipv4Addresses.length > 0) {
        const ipSet = new wafv2.CfnIPSet(this, 'AllowedIpSet', {
          name: `${props.pascalCaseName}-AllowedIPs`,
          description: `Allowed IP ranges for ${props.productName} management console`,
          scope: 'CLOUDFRONT',
          ipAddressVersion: 'IPV4',
          addresses: ipv4Addresses,
        });

        rules.push({
          name: 'AllowWhitelistedIPv4',
          priority: ruleIndex++,
          action: { allow: {} },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: `${props.pascalCaseName}-AllowedIPv4`,
            sampledRequestsEnabled: true,
          },
          statement: {
            ipSetReferenceStatement: { arn: ipSet.attrArn },
          },
        });
      }

      if (ipv6Addresses.length > 0) {
        const ipv6Set = new wafv2.CfnIPSet(this, 'AllowedIpSetV6', {
          name: `${props.pascalCaseName}-AllowedIPs-IPv6`,
          description: `Allowed IPv6 ranges for ${props.productName} management console`,
          scope: 'CLOUDFRONT',
          ipAddressVersion: 'IPV6',
          addresses: ipv6Addresses,
        });

        rules.push({
          name: 'AllowWhitelistedIPv6',
          priority: ruleIndex++,
          action: { allow: {} },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: `${props.pascalCaseName}-AllowedIPv6`,
            sampledRequestsEnabled: true,
          },
          statement: {
            ipSetReferenceStatement: { arn: ipv6Set.attrArn },
          },
        });
      }
    }

    // AWS Managed Rules - common web attack protection (always enabled)
    rules.push(
      {
        name: 'AWSManagedRulesCommonRuleSet',
        priority: ruleIndex++,
        overrideAction: { none: {} },
        visibilityConfig: {
          cloudWatchMetricsEnabled: true,
          metricName: `${props.pascalCaseName}-CommonRuleSet`,
          sampledRequestsEnabled: true,
        },
        statement: {
          managedRuleGroupStatement: {
            vendorName: 'AWS',
            name: 'AWSManagedRulesCommonRuleSet',
          },
        },
      },
      {
        name: 'AWSManagedRulesKnownBadInputsRuleSet',
        priority: ruleIndex++,
        overrideAction: { none: {} },
        visibilityConfig: {
          cloudWatchMetricsEnabled: true,
          metricName: `${props.pascalCaseName}-KnownBadInputs`,
          sampledRequestsEnabled: true,
        },
        statement: {
          managedRuleGroupStatement: {
            vendorName: 'AWS',
            name: 'AWSManagedRulesKnownBadInputsRuleSet',
          },
        },
      },
      {
        name: 'AWSManagedRulesAmazonIpReputationList',
        priority: ruleIndex++,
        overrideAction: { none: {} },
        visibilityConfig: {
          cloudWatchMetricsEnabled: true,
          metricName: `${props.pascalCaseName}-IpReputation`,
          sampledRequestsEnabled: true,
        },
        statement: {
          managedRuleGroupStatement: {
            vendorName: 'AWS',
            name: 'AWSManagedRulesAmazonIpReputationList',
          },
        },
      },
    );

    const webAcl = new wafv2.CfnWebACL(this, 'WebAcl', {
      name: `${props.pascalCaseName}-CloudFront-WAF`,
      description: `${hasIpWhitelist ? 'IP-restricted' : 'Managed rules'} protection for ${props.productName}`,
      scope: 'CLOUDFRONT',
      defaultAction: hasIpWhitelist ? { block: {} } : { allow: {} },
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: `${props.pascalCaseName}-WAF`,
        sampledRequestsEnabled: true,
      },
      rules,
    });

    this.webAclArn = webAcl.attrArn;

    new cdk.CfnOutput(this, 'WebAclArn', {
      value: webAcl.attrArn,
      description: 'WAF WebACL ARN for CloudFront protection',
    });

    if (hasIpWhitelist) {
      new cdk.CfnOutput(this, 'WafMode', {
        value: 'IP-RESTRICTED',
        description: 'WAF mode: IP-RESTRICTED (block all except whitelisted) or MANAGED-RULES (allow all, block known attacks)',
      });
    }
  }
}
