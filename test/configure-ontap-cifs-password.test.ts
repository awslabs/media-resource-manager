// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the SMB local-user password that the regional hub's
 * configure-ontap-cifs Lambda generates (lambda/configure-ontap-cifs).
 */
// The Lambda runtime provides these clients. The repo doesn't install them all.
jest.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: jest.fn(), GetSecretValueCommand: jest.fn(), UpdateSecretCommand: jest.fn(),
}), { virtual: true });
jest.mock('@aws-sdk/client-fsx', () => ({ FSxClient: jest.fn(), DescribeStorageVirtualMachinesCommand: jest.fn() }), { virtual: true });
jest.mock('@aws-sdk/client-lambda', () => ({ LambdaClient: jest.fn(), InvokeCommand: jest.fn() }), { virtual: true });
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn() }), { virtual: true });
jest.mock('@aws-sdk/lib-dynamodb', () => ({ DynamoDBDocumentClient: { from: jest.fn() }, GetCommand: jest.fn() }), { virtual: true });

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { generatePassword } = require('../lambda/configure-ontap-cifs/index.js');

describe('configure-ontap-cifs generatePassword', () => {
  afterEach(() => jest.restoreAllMocks());

  it('returns 16 characters with every character class, from the same character set', () => {
    for (let run = 0; run < 200; run++) {
      const password: string = generatePassword();
      expect(password).toMatch(/^[A-Za-z0-9!@#$%^&*]{16}$/);
      expect(password).toMatch(/[a-z]/);
      expect(password).toMatch(/[A-Z]/);
      expect(password).toMatch(/[0-9]/);
      expect(password).toMatch(/[!@#$%^&*]/);
    }
  });

  it('never uses Math.random', () => {
    const random = jest.spyOn(Math, 'random');
    generatePassword();
    expect(random).not.toHaveBeenCalled();
  });

  it('does not repeat passwords', () => {
    const seen = new Set(Array.from({ length: 200 }, () => generatePassword()));
    expect(seen.size).toBe(200);
  });
});
