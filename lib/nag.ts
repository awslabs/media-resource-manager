// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { App, Aspects } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';

/**
 * Adds the cdk-nag AwsSolutions checks to every stack, but only when the app
 * is synthesized with `-c nag=true` (see docs/CDK_NAG.md). Without the flag
 * the app is unchanged. The aspect only adds annotations, so the templates are
 * the same either way; with the flag, findings are reported as synth errors
 * and warnings, and a CSV report per stack is written to the output folder.
 */
export function addNagChecks(app: App): void {
  const nag = app.node.tryGetContext('nag');
  if (nag === true || nag === 'true') {
    Aspects.of(app).add(new AwsSolutionsChecks({ reports: true }));
  }
}
