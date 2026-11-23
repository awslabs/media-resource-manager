// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { LinuxWorkstationCreationStack } from '../lib/workstation-creation-stack-linux';

/**
 * Hermetic synth of the Linux workstation creation stack. Checks that the
 * workflow waits for a READY console session after the DCV server registers,
 * and fails the creation when none becomes READY.
 */
function synth(): Template {
  const app = new cdk.App();
  const env = { account: '123456789012', region: 'us-east-1' };
  const deps = new cdk.Stack(app, 'Deps', { env });
  const table = (id: string) => new dynamodb.Table(deps, id, {
    partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
  });
  const vpc = new ec2.Vpc(deps, 'Vpc', { maxAzs: 2 });
  const stack = new LinuxWorkstationCreationStack(app, 'Linux', {
    env,
    productName: 'Media Resource Manager',
    pascalCaseName: 'MediaResourceManager',
    acronym: 'MRM',
    workstationTable: table('Workstations'),
    imagePipelinesTable: table('Pipelines'),
    amiTable: table('Amis'),
    hostnameCounterTable: table('Hostnames'),
    regionalHubsTable: table('Hubs'),
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

/** Names of the states that can move to `target`. */
function sourcesOf(s: Record<string, any>, target: string): string[] {
  return Object.entries(s)
    .filter(([, st]) => st.Next === target || st.Default === target
      || (st.Choices || []).some((c: any) => c.Next === target))
    .map(([name]) => name);
}

/** IAM statements attached to the role of the named function. */
function statementsFor(template: Template, functionName: string): any[] {
  const fns = template.findResources('AWS::Lambda::Function', { Properties: { FunctionName: functionName } });
  const roleId = Object.values(fns)[0].Properties.Role['Fn::GetAtt'][0];
  return Object.values(template.findResources('AWS::IAM::Policy'))
    .filter((p: any) => p.Properties.Roles.some((r: any) => r.Ref === roleId))
    .flatMap((p: any) => p.Properties.PolicyDocument.Statement);
}

describe('LinuxWorkstationCreationStack console session check', () => {
  const template = synth();
  const s = states(template);

  it('checks for a READY console session once the DCV server is registered', () => {
    const dcvReady = s['DcvReady?'];
    const ready = dcvReady.Choices.find((c: any) => c.Variable === '$.dcvReady');
    expect(ready).toEqual({ Variable: '$.dcvReady', BooleanEquals: true, Next: 'CheckLinuxConsoleSession' });
    expect(s.CheckLinuxConsoleSession.Next).toBe('LinuxConsoleSessionReady?');
  });

  it('marks the workstation Complete only when the session is READY', () => {
    const choice = s['LinuxConsoleSessionReady?'];
    expect(choice.Choices[0]).toEqual({
      Variable: '$.consoleSessionReady', BooleanEquals: true, Next: 'UpdateStatusComplete',
    });
    expect(sourcesOf(s, 'UpdateStatusComplete')).toEqual(['LinuxConsoleSessionReady?']);
  });

  it('polls every 30 seconds, up to 20 checks', () => {
    const choice = s['LinuxConsoleSessionReady?'];
    expect(choice.Choices[1]).toEqual({
      Variable: '$.consoleSessionChecks', NumericGreaterThanEquals: 20, Next: 'FailConsoleSessionTimeout',
    });
    expect(choice.Default).toBe('WaitForLinuxConsoleSession');
    expect(s.WaitForLinuxConsoleSession).toMatchObject({ Seconds: 30, Next: 'CheckLinuxConsoleSession' });
  });

  it('fails the creation with a reason when no session becomes READY', () => {
    const fail = s.FailConsoleSessionTimeout;
    expect(fail.Next).toBe('LinuxWorkstationCreationFailed');
    expect(fail.Parameters.UpdateExpression).toBe(
      'SET #status = :status, dcvStatus = :dcvStatus, failureReason = :failureReason');
    expect(fail.Parameters.ExpressionAttributeValues[':status']).toEqual({ S: 'failed' });
    expect(fail.Parameters.ExpressionAttributeValues[':failureReason'].S)
      .toMatch(/console session did not become ready within 10 minutes/);
    expect(s.LinuxWorkstationCreationFailed.Type).toBe('Fail');
  });

  it('leaves the other failure updates unchanged', () => {
    expect(s.FailDcvTimeout.Parameters.UpdateExpression).toBe('SET #status = :status, dcvStatus = :dcvStatus');
    expect(s.FailDcvTimeout.Parameters.ExpressionAttributeValues[':failureReason']).toBeUndefined();
  });

  it('runs the shared check in the VPC as the Linux variant', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'mrm-console-session-ready-linux',
      Runtime: 'python3.12',
      Handler: 'index.lambda_handler',
      VpcConfig: { SubnetIds: Match.anyValue() },
      Environment: {
        Variables: Match.objectLike({
          SESSION_PLATFORM: 'Linux',
          PASCAL_CASE_NAME: 'MediaResourceManager',
          WORKSTATION_TABLE_NAME: Match.anyValue(),
          REGIONAL_SESSION_MANAGER_FUNCTION: 'mrm-regional-dcv-session-manager',
        }),
      },
    });
  });

  it('grants only what the check needs', () => {
    const statements = statementsFor(template, 'mrm-console-session-ready-linux');

    const ssm = statements.filter((st: any) => st.Action === 'ssm:GetParameter');
    expect(ssm).toHaveLength(1);
    expect(ssm[0].Resource).toHaveLength(3);
    const resources = JSON.stringify(ssm[0].Resource);
    for (const name of ['Endpoint', 'ClientId', 'ClientPassword']) {
      expect(resources).toContain(`:parameter/MediaResourceManager/DCV/SessionManager/${name}`);
    }

    const dynamo = statements.filter((st: any) => [st.Action].flat().some((a: string) => a.startsWith('dynamodb:')));
    expect(dynamo).toHaveLength(1);
    expect(dynamo[0].Action).toBe('dynamodb:GetItem');

    const ec2Statements = statements.filter((st: any) => [st.Action].flat().some((a: string) => a.startsWith('ec2:')));
    expect(ec2Statements).toEqual([expect.objectContaining({ Action: 'ec2:DescribeImages', Resource: '*' })]);

    // Hub workstations: only the hubs' dcv-session-manager copies.
    const invoke = statements.filter((st: any) => [st.Action].flat().some((a: string) => a.startsWith('lambda:')));
    expect(invoke).toHaveLength(1);
    expect(invoke[0].Action).toBe('lambda:InvokeFunction');
    expect(JSON.stringify(invoke[0].Resource)).toMatch(/arn:aws:lambda:\*:.*:function:mrm-regional-dcv-session-manager"/);

    const writes = statements.flatMap((st: any) => [st.Action].flat())
      .filter((a: string) => /^(dynamodb:(Put|Update|Delete|BatchWrite)|ssm:Put|ec2:(Run|Terminate|Create))/.test(a));
    expect(writes).toEqual([]);
  });
});
