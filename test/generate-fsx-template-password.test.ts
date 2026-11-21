// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the FSx for ONTAP admin password generator
 * (generateOntapPassword in lambda/generate-fsx-template).
 */
// The Lambda runtime provides this client. The repo doesn't install it.
jest.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: jest.fn(),
  GetSecretValueCommand: jest.fn(),
}), { virtual: true });

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { generateOntapPassword } = require('../lambda/generate-fsx-template/index.js');

const RUNS = 200;
const ALLOWED = /^[a-zA-Z0-9!@#$%^&*]+$/;

function generateMany(): string[] {
  return Array.from({ length: RUNS }, () => generateOntapPassword());
}

describe('generateOntapPassword', () => {
  afterEach(() => jest.restoreAllMocks());

  it('is 24 characters, within the ONTAP limit of 8-50', () => {
    for (const password of generateMany()) {
      expect(password).toHaveLength(24);
    }
  });

  it('has at least one lowercase letter, uppercase letter, digit and special character', () => {
    for (const password of generateMany()) {
      expect(password).toMatch(/[a-z]/);
      expect(password).toMatch(/[A-Z]/);
      expect(password).toMatch(/[0-9]/);
      expect(password).toMatch(/[!@#$%^&*]/);
    }
  });

  it('uses only the allowed characters', () => {
    for (const password of generateMany()) {
      expect(password).toMatch(ALLOWED);
    }
  });

  it('shuffles the required characters instead of leaving them at the front', () => {
    const firstChars = new Set(generateMany().map(p => p[0]));
    // Without a shuffle the first character would always be lowercase.
    expect([...firstChars].some(c => !/[a-z]/.test(c))).toBe(true);
  });

  it('never uses Math.random', () => {
    const spy = jest.spyOn(Math, 'random');
    generateMany();
    expect(spy).not.toHaveBeenCalled();
  });

  it('does not repeat passwords', () => {
    expect(new Set(generateMany()).size).toBe(RUNS);
  });
});
