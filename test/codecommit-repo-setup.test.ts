// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the external developer policy in
 * scripts/codecommit-repo-setup.yaml: pushes to protected branches are denied
 * for each branch pattern.
 */
import * as path from 'path';
import { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { CfnInclude } from 'aws-cdk-lib/cloudformation-include';

const TEMPLATE = path.join(__dirname, '..', 'scripts', 'codecommit-repo-setup.yaml');

type Statement = {
  Sid?: string;
  Effect: string;
  Action: string[];
  Condition?: Record<string, Record<string, string | string[]>>;
};

function loadStatements(): Statement[] {
  const stack = new Stack(new App(), 'CodeCommitRepoSetup');
  new CfnInclude(stack, 'Template', { templateFile: TEMPLATE });
  const resources = Template.fromStack(stack).toJSON().Resources;
  return resources.ExternalDeveloperPolicy.Properties.PolicyDocument.Statement as Statement[];
}

function likeToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

// Evaluates one IAM condition block for a request with the given ref
// (codecommit:References is a single-valued String key). Operators and keys
// in one block are ANDed; the values listed for one key are ORed.
function conditionMatches(condition: Statement['Condition'], ref: string | undefined): boolean {
  return Object.entries(condition ?? {}).every(([operator, keys]) =>
    Object.entries(keys).every(([key, raw]) => {
      expect(key).toBe('codecommit:References');
      const values = Array.isArray(raw) ? raw : [raw];
      if (operator === 'Null') return values.includes(String(ref === undefined));
      if (ref === undefined) return operator.endsWith('IfExists');
      if (operator.startsWith('StringLike')) return values.some((v) => likeToRegex(v).test(ref));
      if (operator.startsWith('StringEquals')) return values.includes(ref);
      throw new Error(`unexpected condition operator ${operator}`);
    }),
  );
}

describe('codecommit-repo-setup.yaml external developer policy', () => {
  const statements = loadStatements();
  const denies = statements.filter((s) => s.Effect === 'Deny' && s.Action.includes('codecommit:GitPush'));

  function pushDenied(ref: string | undefined): boolean {
    return denies.some((s) => conditionMatches(s.Condition, ref));
  }

  test('has a GitPush deny statement', () => {
    expect(denies.length).toBeGreaterThan(0);
  });

  test.each(['refs/heads/main', 'refs/heads/deploy/prod', 'refs/heads/deploy/us-west-2'])(
    'denies a push to %s',
    (ref) => {
      expect(pushDenied(ref)).toBe(true);
    },
  );

  test.each(['refs/heads/feature/my-changes', 'refs/heads/mainline', 'refs/heads/deployer'])(
    'does not deny a push to %s',
    (ref) => {
      expect(pushDenied(ref)).toBe(false);
    },
  );

  test('applies the deny only to requests that carry refs', () => {
    for (const s of denies) {
      expect(s.Condition?.Null?.['codecommit:References']).toBe('false');
    }
    expect(pushDenied(undefined)).toBe(false);
  });
});
