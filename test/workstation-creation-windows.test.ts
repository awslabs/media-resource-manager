// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { spawnSync } from 'child_process';
import * as path from 'path';
import { WindowsWorkstationCreationStack } from '../lib/workstation-creation-stack-windows';

/**
 * Hermetic synth of the Windows workstation creation stack. Checks that the
 * workflow waits for a READY console session after the final reboot instead
 * of marking the workstation Complete right after a fixed wait.
 */
function synth(): Template {
  const app = new cdk.App();
  const env = { account: '123456789012', region: 'us-east-1' };
  const deps = new cdk.Stack(app, 'Deps', { env });
  const table = (id: string) => new dynamodb.Table(deps, id, {
    partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
  });
  const vpc = new ec2.Vpc(deps, 'Vpc', { maxAzs: 2 });
  const stack = new WindowsWorkstationCreationStack(app, 'Windows', {
    env,
    productName: 'Media Resource Manager',
    pascalCaseName: 'MediaResourceManager',
    acronym: 'MRM',
    workstationTable: table('Workstations'),
    imagePipelinesTable: table('Pipelines'),
    amiTable: table('Amis'),
    hostnameCounterTable: table('Hostnames'),
    vpc,
    workstationSecurityGroup: new ec2.SecurityGroup(deps, 'Sg', { vpc }),
    workstationLaunchTemplate: new ec2.LaunchTemplate(deps, 'Lt', {
      role: new iam.Role(deps, 'Role', { assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com') }),
    }),
    sessionCleanupFunction: new lambda.Function(deps, 'Cleanup', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      code: lambda.Code.fromInline('def handler(e, c): return e'),
    }),
    dataEncryptionKey: new kms.Key(deps, 'Key'),
  });
  return Template.fromStack(stack);
}

/** Parse the state machine definition, replacing CloudFormation tokens with a placeholder. */
function states(template: Template): Record<string, any> {
  const machines = template.findResources('AWS::StepFunctions::StateMachine');
  const definition = Object.values(machines)[0].Properties.DefinitionString;
  const parts: unknown[] = definition['Fn::Join'] ? definition['Fn::Join'][1] : [definition];
  const json = parts.map(p => (typeof p === 'string' ? p : 'TOKEN')).join('');
  return JSON.parse(json).States;
}

describe('WindowsWorkstationCreationStack post-reboot console session check', () => {
  const template = synth();
  const s = states(template);

  it.each([
    ['NoCleanup', 'UpdateStatusCompleteNoCleanup'],
    ['', 'UpdateStatusComplete'],
  ])('checks for a READY console session after WaitForRestart%s', (suffix, complete) => {
    expect(s[`WaitForRestart${suffix}`].Next).toBe(`CheckConsoleSession${suffix}`);
    expect(s[`CheckConsoleSession${suffix}`].Next).toBe(`IsConsoleSessionReady${suffix}?`);

    const choice = s[`IsConsoleSessionReady${suffix}?`];
    expect(choice.Type).toBe('Choice');
    expect(choice.Choices).toHaveLength(1);
    expect(choice.Choices[0].Next).toBe(complete);
    expect(choice.Choices[0].Or).toEqual([
      { Variable: '$.consoleSessionReady', BooleanEquals: true },
      { Variable: '$.consoleSessionChecks', NumericGreaterThanEquals: 20 },
    ]);
    expect(choice.Default).toBe(`WaitForConsoleSession${suffix}`);

    const wait = s[`WaitForConsoleSession${suffix}`];
    expect(wait.Seconds).toBe(30);
    expect(wait.Next).toBe(`CheckConsoleSession${suffix}`);
  });

  it('only reaches Complete through the console session check', () => {
    for (const complete of ['UpdateStatusComplete', 'UpdateStatusCompleteNoCleanup']) {
      const sources = Object.entries(s)
        .filter(([, st]) => st.Next === complete || st.Default === complete
          || (st.Choices || []).some((c: any) => c.Next === complete))
        .map(([name]) => name);
      expect(sources).toEqual([expect.stringMatching(/^IsConsoleSessionReady/)]);
    }
  });

  it('runs the check in the VPC with read access to the Session Manager parameters only', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'mrm-console-session-ready-windows',
      Runtime: 'python3.12',
      VpcConfig: { SubnetIds: Match.anyValue() },
    });

    const fns = template.findResources('AWS::Lambda::Function', {
      Properties: { FunctionName: 'mrm-console-session-ready-windows' },
    });
    const roleId = Object.values(fns)[0].Properties.Role['Fn::GetAtt'][0];
    const policies = Object.values(template.findResources('AWS::IAM::Policy'))
      .filter((p: any) => p.Properties.Roles.some((r: any) => r.Ref === roleId));
    const statements = policies.flatMap((p: any) => p.Properties.PolicyDocument.Statement);
    const ssm = statements.filter((st: any) => st.Action === 'ssm:GetParameter');
    expect(ssm).toHaveLength(1);
    const resources = JSON.stringify(ssm[0].Resource);
    for (const name of ['Endpoint', 'ClientId', 'ClientPassword']) {
      expect(resources).toContain(`:parameter/MediaResourceManager/DCV/SessionManager/${name}`);
    }
    expect(ssm[0].Resource).toHaveLength(3);
  });
});

describe('console-session-ready Lambda', () => {
  it('passes its Python unit tests', () => {
    const result = spawnSync('python3', ['-m', 'unittest', path.join(__dirname, 'python', 'test_console_session_ready.py')], {
      encoding: 'utf8',
    });
    if (result.status !== 0) {
      throw new Error(`${result.stdout}\n${result.stderr}`);
    }
    expect(result.stderr).toMatch(/OK/);
  });
});
