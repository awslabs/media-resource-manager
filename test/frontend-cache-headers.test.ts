// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Console cache headers: after an upgrade, browsers must load the new
 * index.html and config.json without a hard refresh, while the hashed bundles
 * under assets/ stay cacheable for a long time.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import { Template } from 'aws-cdk-lib/assertions';
import { FrontendStack } from '../lib/frontend-stack';

const mockS3Send = jest.fn();
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn(() => ({ send: mockS3Send })),
  PutObjectCommand: jest.fn((input) => ({ name: 'PutObject', input })),
}), { virtual: true });
const mockSsmSend = jest.fn();
jest.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: jest.fn(() => ({ send: mockSsmSend })),
  GetParameterCommand: jest.fn((input) => ({ name: 'GetParameter', input })),
}), { virtual: true });
jest.mock('@aws-sdk/client-cognito-identity-provider', () => ({
  CognitoIdentityProviderClient: jest.fn(() => ({ send: jest.fn().mockResolvedValue({ Providers: [] }) })),
  ListIdentityProvidersCommand: jest.fn((input) => ({ name: 'ListIdentityProviders', input })),
}), { virtual: true });

const fakeDist = fs.mkdtempSync(path.join(os.tmpdir(), 'mrm-frontend-dist-'));
fs.writeFileSync(path.join(fakeDist, 'index.html'), '<html></html>');
fs.mkdirSync(path.join(fakeDist, 'assets'));
fs.writeFileSync(path.join(fakeDist, 'assets', 'index-abc123.js'), '');
afterAll(() => fs.rmSync(fakeDist, { recursive: true, force: true }));

function synthFrontend() {
  const realAsset = s3deploy.Source.asset;
  jest.spyOn(s3deploy.Source, 'asset').mockImplementation((p, options) =>
    realAsset.call(s3deploy.Source, p === './frontend/dist' ? fakeDist : p, options));
  const app = new cdk.App();
  const stack = new FrontendStack(app, 'FrontendTestStack', {
    env: { account: '123456789012', region: 'us-east-1' },
    productName: 'Media Resource Manager',
    pascalCaseName: 'MediaResourceManager',
    acronym: 'MRM',
  });
  return Template.fromStack(stack);
}

describe('Frontend cache headers', () => {
  const template = synthFrontend();
  const deployments = template.findResources('Custom::CDKBucketDeployment');
  const entries = Object.entries(deployments);
  const assets = entries.find(([, r]) => (r.Properties.Include || []).includes('assets/*'));
  const website = entries.find(([, r]) => r.Properties.DistributionPaths);

  it('uploads hashed assets/ bundles with a long immutable Cache-Control', () => {
    expect(entries).toHaveLength(2);
    expect(assets).toBeDefined();
    const props = assets![1].Properties;
    expect(props.Exclude).toEqual(['*']);
    expect(props.SystemMetadata).toEqual({ 'cache-control': 'public, max-age=31536000, immutable' });
    // Old bundles stay so open tabs from the previous release keep working.
    expect(props.Prune).toBe(false);
  });

  it('uploads index.html and other unhashed files with no-cache', () => {
    expect(website).toBeDefined();
    const [, resource] = website!;
    expect(resource.Properties.SystemMetadata).toEqual({ 'cache-control': 'no-cache' });
    // Its prune must not delete the bundles or the generated config.json.
    expect(resource.Properties.Exclude).toEqual(expect.arrayContaining(['assets/*', 'config.json']));
    expect(resource.Properties.DistributionPaths).toEqual(['/*']);
    // Bundles are in the bucket before the index.html that references them.
    expect(resource.DependsOn).toEqual(expect.arrayContaining([assets![0]]));
  });

  it('serves index.html as the 404 fallback, so the fallback carries the same header', () => {
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: {
        DefaultRootObject: 'index.html',
        CustomErrorResponses: [{ ErrorCode: 404, ResponseCode: 200, ResponsePagePath: '/index.html' }],
      },
    });
  });

  it('generates config.json after the website upload', () => {
    const [configResource] = Object.values(template.findResources('AWS::CloudFormation::CustomResource', {
      Properties: { BucketName: {} },
    }));
    expect(configResource.DependsOn).toEqual(expect.arrayContaining([website![0]]));
  });
});

describe('config generator', () => {
  it('writes config.json with Cache-Control: no-cache', async () => {
    mockSsmSend.mockImplementation(async (command: { input: { Name: string } }) => {
      if (command.input.Name.endsWith('/Workstation/ApiUrl')) {
        return { Parameter: { Value: 'https://api.example.com/' } };
      }
      throw Object.assign(new Error('not found'), { name: 'ParameterNotFound' });
    });
    mockS3Send.mockResolvedValue({});
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { handler } = require('../lambda/config-generator/index.js');

    await handler({ RequestType: 'Create', ResourceProperties: { BucketName: 'frontend-bucket' } });

    const put = mockS3Send.mock.calls.map(([c]) => c).find((c) => c.name === 'PutObject');
    expect(put.input).toMatchObject({
      Bucket: 'frontend-bucket',
      Key: 'config.json',
      ContentType: 'application/json',
      CacheControl: 'no-cache',
    });
  });
});
