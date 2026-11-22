// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The storage CloudFormation worker logs its action, Region and stack name,
 * not its template body or parameter values.
 */

export {}; // module scope, so names here don't clash with other test files

const mockSend = jest.fn();
const mockCreateStackInputs: any[] = [];

jest.mock('@aws-sdk/client-cloudformation', () => ({
  CloudFormationClient: jest.fn().mockImplementation(() => ({ send: mockSend })),
  CreateStackCommand: jest.fn().mockImplementation((input: any) => {
    mockCreateStackInputs.push(input);
    return { input };
  }),
  DescribeStacksCommand: jest.fn().mockImplementation((input: any) => ({ input })),
  DeleteStackCommand: jest.fn().mockImplementation((input: any) => ({ input })),
}), { virtual: true });

// eslint-disable-next-line @typescript-eslint/no-var-requires
const storageCfnWorker = require('../lambda/storage-cfn-worker/index.js');

const PARAMETER_VALUE = 'example-parameter-value-7f3a'; // pragma: allowlist secret
const TEMPLATE_MARKER = 'ExampleTemplateMarker9c2e';

let logged: string;
let spies: jest.SpyInstance[];

beforeEach(() => {
  logged = '';
  mockCreateStackInputs.length = 0;
  mockSend.mockReset();
  const capture = (...args: unknown[]) => {
    logged += args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ') + '\n';
  };
  spies = (['log', 'info', 'warn', 'error', 'debug'] as const)
    .map(level => jest.spyOn(console, level).mockImplementation(capture));
});

afterEach(() => {
  spies.forEach(s => s.mockRestore());
});

describe('storage-cfn-worker logging', () => {
  it('logs the action, Region and stack name, not the template or parameter values', async () => {
    mockSend.mockResolvedValue({ StackId: 'arn:aws:cloudformation:us-west-2:123456789012:stack/example-storage/abc' });

    const result = await storageCfnWorker.handler({
      action: 'createStack',
      region: 'us-west-2',
      stackName: 'example-storage',
      templateBody: JSON.stringify({ Description: TEMPLATE_MARKER, Resources: {} }),
      parameters: [
        { ParameterKey: 'StorageName', ParameterValue: 'example' },
        { ParameterKey: 'ExampleParameter', ParameterValue: PARAMETER_VALUE },
      ],
    });

    expect(result.status).toBe('CREATE_IN_PROGRESS');
    // The stack still gets the template and every parameter.
    expect(mockCreateStackInputs[0].TemplateBody).toContain(TEMPLATE_MARKER);
    expect(mockCreateStackInputs[0].Parameters).toContainEqual({ ParameterKey: 'ExampleParameter', ParameterValue: PARAMETER_VALUE });

    expect(logged).toContain('createStack');
    expect(logged).toContain('us-west-2');
    expect(logged).toContain('example-storage');
    expect(logged).not.toContain(PARAMETER_VALUE);
    expect(logged).not.toContain(TEMPLATE_MARKER);
  });
});
