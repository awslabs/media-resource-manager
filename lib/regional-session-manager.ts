// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as iam from 'aws-cdk-lib/aws-iam';

/**
 * Name of the dcv-session-manager copy in each regional hub (see
 * DcvSessionManagerFunction in lambda/generate-regional-hub-template).
 */
export function regionalSessionManagerFunctionName(acronym: string): string {
  return `${acronym.toLowerCase()}-regional-dcv-session-manager`;
}

/** Lets a primary-Region Lambda invoke the hubs' dcv-session-manager copies. */
export function invokeRegionalSessionManagerStatement(account: string, acronym: string): iam.PolicyStatement {
  return new iam.PolicyStatement({
    effect: iam.Effect.ALLOW,
    actions: ['lambda:InvokeFunction'],
    resources: [`arn:aws:lambda:*:${account}:function:${regionalSessionManagerFunctionName(acronym)}`],
  });
}
