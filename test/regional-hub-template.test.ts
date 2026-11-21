// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for updating a regional hub's stack with a newly generated
 * template (lambda/generate-regional-hub-template).
 */
// The Lambda runtime provides this client. The repo doesn't install it.
jest.mock('@aws-sdk/client-cloudformation', () => ({
  CloudFormationClient: jest.fn(),
  GetTemplateCommand: jest.fn(),
}), { virtual: true });

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { generateCloudFormationTemplate } = require('../lambda/generate-regional-hub-template/index.js');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { keepDeployedIamNames } = require('../lambda/generate-regional-hub-template/deployed-names.js');

const IAM_NAME_PROPERTIES: Record<string, string> = {
  'AWS::IAM::Role': 'RoleName',
  'AWS::IAM::InstanceProfile': 'InstanceProfileName',
};

function generate() {
  return generateCloudFormationTemplate({
    productName: 'MediaResourceManager',
    acronym: 'MRM',
    region: 'us-west-2',
    displayName: 'US West (Oregon)',
    vpcCidr: '10.1.0.0/16',
    availabilityZones: ['us-west-2a', 'us-west-2b'],
    primaryRegion: 'us-east-1',
    enableWindows: true,
    enableLinux: true,
    enableMacOS: true,
    lambdaAssets: {
      dcvSessionManager: { bucket: 'assets', key: 'dcv-session-manager.zip' },
      configureOntapCifs: { bucket: 'assets', key: 'configure-ontap-cifs.zip' },
    },
  });
}

function iamResources(template: any): [string, any][] {
  return Object.entries(template.Resources).filter(([, r]: [string, any]) => IAM_NAME_PROPERTIES[r.Type]);
}

/** The same template as a hub created before IAM names had a region suffix. */
function legacyHub(template: any) {
  const deployed = JSON.parse(JSON.stringify(template));
  for (const [, resource] of iamResources(deployed)) {
    const prop = IAM_NAME_PROPERTIES[resource.Type];
    const name = resource.Properties[prop];
    if (typeof name === 'string') {
      resource.Properties[prop] = { 'Fn::Sub': name.replace(/^MediaResourceManager/, '${ProductName}').replace(/-uswest2$/, '') };
    }
  }
  return deployed;
}

describe('regional hub template', () => {
  it('updates every SSM document in place, since their names are fixed', () => {
    const docs = Object.values(generate().Resources).filter((r: any) => r.Type === 'AWS::SSM::Document');
    expect(docs.length).toBeGreaterThan(0);
    for (const doc of docs as any[]) {
      expect(doc.Properties.UpdateMethod).toBe('NewVersion');
    }
  });

  it('gives a new hub region-suffixed IAM names', () => {
    const template = generate();
    expect(template.Resources.WorkstationRole.Properties.RoleName).toBe('MediaResourceManager-Regional-Workstation-Role-uswest2');
    expect(template.Resources.WorkstationInstanceProfile.Properties.InstanceProfileName)
      .toBe('MediaResourceManager-Regional-Workstation-Profile-uswest2');
  });

  it('outputs the workstation instance profile name from the resource itself', () => {
    expect(generate().Outputs.WorkstationInstanceProfileName.Value).toEqual({ Ref: 'WorkstationInstanceProfile' });
  });
});

describe('keepDeployedIamNames', () => {
  it('keeps the names of a hub created before region suffixes', () => {
    const template = generate();
    const deployed = legacyHub(template);
    const kept = keepDeployedIamNames(template, deployed);

    expect(kept).toEqual(expect.arrayContaining(['WorkstationRole', 'WorkstationInstanceProfile', 'SessionManagerRole']));
    for (const [logicalId, resource] of iamResources(template)) {
      const prop = IAM_NAME_PROPERTIES[resource.Type];
      expect(resource.Properties[prop]).toEqual(deployed.Resources[logicalId].Properties[prop]);
    }
    expect(template.Resources.WorkstationRole.Properties.RoleName).toEqual({ 'Fn::Sub': '${ProductName}-Regional-Workstation-Role' });
  });

  it('changes nothing for a hub that already has the current names', () => {
    const template = generate();
    const before = JSON.stringify(template);
    expect(keepDeployedIamNames(template, generate())).toEqual([]);
    expect(JSON.stringify(template)).toBe(before);
  });

  it('only changes IAM names', () => {
    const template = generate();
    const deployed = legacyHub(template);
    deployed.Resources.WorkstationSecurityGroup = { Type: 'AWS::EC2::SecurityGroup', Properties: { GroupName: 'old-name' } };
    keepDeployedIamNames(template, deployed);
    const otherBefore = Object.entries(generate().Resources).filter(([, r]: [string, any]) => !IAM_NAME_PROPERTIES[r.Type]);
    const otherAfter = Object.entries(template.Resources).filter(([, r]: [string, any]) => !IAM_NAME_PROPERTIES[r.Type]);
    expect(otherAfter).toEqual(otherBefore);
  });

  it('names new resources as generated', () => {
    const template = generate();
    const deployed = legacyHub(template);
    delete deployed.Resources.DcvLambdaRole;
    keepDeployedIamNames(template, deployed);
    expect(template.Resources.DcvLambdaRole.Properties.RoleName).toBe('MediaResourceManager-Regional-DCV-Lambda-Role-uswest2');
  });

  it('drops the name of a resource deployed without one', () => {
    const template = generate();
    const deployed = legacyHub(template);
    delete deployed.Resources.EmptyBucketRole.Properties.RoleName;
    expect(keepDeployedIamNames(template, deployed)).toContain('EmptyBucketRole');
    expect(template.Resources.EmptyBucketRole.Properties).not.toHaveProperty('RoleName');
  });

  it('ignores a logical ID whose type changed', () => {
    const template = generate();
    const deployed = legacyHub(template);
    deployed.Resources.WorkstationRole = { Type: 'AWS::IAM::User', Properties: { UserName: 'x' } };
    expect(keepDeployedIamNames(template, deployed)).not.toContain('WorkstationRole');
    expect(template.Resources.WorkstationRole.Properties.RoleName).toBe('MediaResourceManager-Regional-Workstation-Role-uswest2');
  });
});
