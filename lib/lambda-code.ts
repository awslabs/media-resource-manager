// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';

const LAMBDA_ROOT = path.join(__dirname, '..', 'lambda');

/**
 * Code and handler for a Lambda in lambda/<dir> that requires modules from
 * lambda/shared, for example require('../shared/log-redact').
 *
 * The package is the lambda/ folder limited to <dir> and shared/, so a shared
 * module exists once in the repo instead of a copy in every function. The
 * function's own files keep the same paths relative to each other, and its
 * handler becomes '<dir>/index.handler'.
 *
 * Use it in place of `code` and `handler`:
 *   new lambda.Function(this, 'Fn', { ...lambdaCodeWithShared('software-library'), runtime, ... })
 */
export function lambdaCodeWithShared(dir: string, handler = 'index.handler'): { code: lambda.Code; handler: string } {
  if (!/^[a-z0-9-]+$/.test(dir) || dir === 'shared') {
    throw new Error(`lambdaCodeWithShared: invalid Lambda directory "${dir}"`);
  }
  return {
    code: lambda.Code.fromAsset(LAMBDA_ROOT, {
      ignoreMode: cdk.IgnoreMode.GLOB,
      exclude: ['*', `!${dir}`, `!${dir}/**`, '!shared', '!shared/**'],
    }),
    handler: `${dir}/${handler}`,
  };
}
