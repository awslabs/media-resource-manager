// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for pipeline base image tracking (#49). AWS calls are replaced
 * with fakes so each step of the lookup order can be checked on its own.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const baseImage = require('../lambda/image-manager/base-image.js');
const { BaseImageError, detectBaseImageSource, resolvePipelineBase, sourceFromImage } = baseImage;

const ACCOUNT_ID = '123456789012';
const RETIRED_AMI = 'ami-0aaaaaaaaaaaaaaa1';
const LATEST_AMI = 'ami-0bbbbbbbbbbbbbbb2';
const CUSTOM_AMI = 'ami-0ccccccccccccccc3';
const DIST_ARN = 'arn:aws:imagebuilder:us-east-1:123456789012:distribution-configuration/mrm-test-dist-abcd1234';

type Image = { ImageId: string; OwnerId: string; Name: string; State?: string; ImageOwnerAlias?: string };

function makeDeps({ tag, images = {}, latest = LATEST_AMI }: {
  tag?: string;
  images?: Record<string, Image>;
  latest?: string;
}) {
  return {
    getDistributionBaseImageTag: jest.fn(async () => tag),
    describeImage: jest.fn(async (amiId: string) => images[amiId] || null),
    resolveLatestAmi: jest.fn(async () => latest),
  };
}

const windows2025Image = (amiId: string): Image => ({
  ImageId: amiId,
  OwnerId: '801119661308',
  ImageOwnerAlias: 'amazon',
  Name: 'Windows_Server-2025-English-Full-Base-2026.07.09',
  State: 'available',
});

describe('resolvePipelineBase with a stored baseImageSource', () => {
  it('moves a built-in base to the latest AMI without running detection', async () => {
    const deps = makeDeps({});
    const result = await resolvePipelineBase(
      { baseImageSource: 'windows-2025', baseImageId: RETIRED_AMI, distributionConfigurationArn: DIST_ARN },
      deps
    );
    expect(result).toEqual({
      source: 'windows-2025',
      sourceWasDetected: false,
      amiId: LATEST_AMI,
      previousAmiId: RETIRED_AMI,
      changed: true,
    });
    expect(deps.resolveLatestAmi).toHaveBeenCalledWith('windows-2025');
    expect(deps.getDistributionBaseImageTag).not.toHaveBeenCalled();
    expect(deps.describeImage).not.toHaveBeenCalled();
  });

  it('reports no change when the base is already the latest AMI', async () => {
    const deps = makeDeps({ latest: LATEST_AMI });
    const result = await resolvePipelineBase({ baseImageSource: 'rocky-8', baseImageId: LATEST_AMI }, deps);
    expect(result.changed).toBe(false);
    expect(result.amiId).toBe(LATEST_AMI);
  });

  it('keeps a custom base pinned while it exists', async () => {
    const deps = makeDeps({
      images: { [CUSTOM_AMI]: { ImageId: CUSTOM_AMI, OwnerId: ACCOUNT_ID, Name: 'golden-editing', State: 'available' } },
    });
    const result = await resolvePipelineBase({ baseImageSource: CUSTOM_AMI, baseImageId: CUSTOM_AMI }, deps);
    expect(result.changed).toBe(false);
    expect(result.amiId).toBe(CUSTOM_AMI);
    expect(deps.resolveLatestAmi).not.toHaveBeenCalled();
  });

  it('fails with a clear error when a custom base is gone, and never swaps it', async () => {
    const deps = makeDeps({});
    const pending = resolvePipelineBase({ baseImageSource: CUSTOM_AMI, baseImageId: CUSTOM_AMI }, deps);
    await expect(pending).rejects.toBeInstanceOf(BaseImageError);
    await expect(pending).rejects.toMatchObject({ code: 'BASE_IMAGE_UNAVAILABLE', statusCode: 409 });
    await expect(pending).rejects.toThrow(`Base image ${CUSTOM_AMI} no longer exists`);
    expect(deps.resolveLatestAmi).not.toHaveBeenCalled();
  });

  it('treats a deregistered custom AMI as gone', async () => {
    const deps = makeDeps({
      images: { [CUSTOM_AMI]: { ImageId: CUSTOM_AMI, OwnerId: ACCOUNT_ID, Name: 'golden', State: 'deregistered' } },
    });
    await expect(resolvePipelineBase({ baseImageSource: CUSTOM_AMI, baseImageId: CUSTOM_AMI }, deps))
      .rejects.toMatchObject({ code: 'BASE_IMAGE_UNAVAILABLE' });
  });
});

describe('detecting baseImageSource for records created before #49', () => {
  it('1. uses the BaseImage tag first, even when the stored AMI is retired', async () => {
    const deps = makeDeps({ tag: 'windows-2025' });
    const result = await resolvePipelineBase(
      { baseImageId: RETIRED_AMI, distributionConfigurationArn: DIST_ARN },
      deps
    );
    expect(deps.getDistributionBaseImageTag).toHaveBeenCalledWith(DIST_ARN);
    expect(deps.describeImage).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      source: 'windows-2025',
      sourceWasDetected: true,
      amiId: LATEST_AMI,
      changed: true,
    });
  });

  it('1. treats an AMI ID in the BaseImage tag as a pinned custom base', async () => {
    const deps = makeDeps({
      tag: CUSTOM_AMI,
      images: { [CUSTOM_AMI]: { ImageId: CUSTOM_AMI, OwnerId: ACCOUNT_ID, Name: 'golden', State: 'available' } },
    });
    const result = await resolvePipelineBase({ baseImageId: CUSTOM_AMI, distributionConfigurationArn: DIST_ARN }, deps);
    expect(result).toMatchObject({ source: CUSTOM_AMI, changed: false });
    expect(deps.resolveLatestAmi).not.toHaveBeenCalled();
  });

  it('2. without a tag, maps a publisher AMI that still exists to its family', async () => {
    const outdated = 'ami-0ddddddddddddddd4';
    const deps = makeDeps({ tag: undefined, images: { [outdated]: windows2025Image(outdated) } });
    const result = await resolvePipelineBase({ baseImageId: outdated, distributionConfigurationArn: DIST_ARN }, deps);
    expect(result).toMatchObject({ source: 'windows-2025', amiId: LATEST_AMI, changed: true });
  });

  it('2. ignores an unrecognized tag value and falls back to the stored AMI', async () => {
    const deps = makeDeps({
      tag: 'windows-2016',
      images: { [CUSTOM_AMI]: { ImageId: CUSTOM_AMI, OwnerId: ACCOUNT_ID, Name: 'golden', State: 'available' } },
    });
    const result = await detectBaseImageSource({ baseImageId: CUSTOM_AMI, distributionConfigurationArn: DIST_ARN }, deps);
    expect(result).toEqual({ source: CUSTOM_AMI, detectedBy: 'ami' });
  });

  it('2. pins an AMI owned by this account', async () => {
    const deps = makeDeps({
      images: { [CUSTOM_AMI]: { ImageId: CUSTOM_AMI, OwnerId: ACCOUNT_ID, Name: 'Windows_Server-2025-golden', State: 'available' } },
    });
    const result = await resolvePipelineBase({ baseImageId: CUSTOM_AMI }, deps);
    expect(result).toMatchObject({ source: CUSTOM_AMI, changed: false });
  });

  it('3. fails without guessing when there is no tag and the AMI is gone', async () => {
    const deps = makeDeps({});
    // baseOsVersion would say "Windows Server 2025" for a custom image too, so it must not be used.
    const pending = resolvePipelineBase(
      { baseImageId: RETIRED_AMI, distributionConfigurationArn: DIST_ARN, baseOsVersion: 'Windows Server 2025' },
      deps
    );
    await expect(pending).rejects.toMatchObject({ code: 'BASE_IMAGE_SOURCE_UNKNOWN', statusCode: 409 });
    expect(deps.resolveLatestAmi).not.toHaveBeenCalled();
  });
});

describe('sourceFromImage', () => {
  it('maps the built-in publisher families', () => {
    expect(sourceFromImage(windows2025Image('ami-1'))).toBe('windows-2025');
    expect(sourceFromImage({
      ImageId: 'ami-2', OwnerId: '801119661308', Name: 'Windows_Server-2022-English-Full-Base-2026.06.11',
    })).toBe('windows-2022');
    expect(sourceFromImage({
      ImageId: 'ami-3', OwnerId: '099720109477', Name: 'ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-20260701',
    })).toBe('ubuntu-22.04');
    expect(sourceFromImage({
      ImageId: 'ami-4', OwnerId: '792107900819', Name: 'Rocky-8-EC2-Base-8.10-20260520.0.x86_64',
    })).toBe('rocky-8');
    expect(sourceFromImage({
      ImageId: 'ami-5', OwnerId: '792107900819', Name: 'Rocky-9-EC2-Base-9.6-20260601.0.x86_64',
    })).toBe('rocky-9');
  });

  it('pins publisher images outside the built-in families', () => {
    const sqlImage = {
      ImageId: 'ami-6', OwnerId: '801119661308', Name: 'Windows_Server-2022-English-Full-SQL_2022_Standard-2026.06.11',
    };
    expect(sourceFromImage(sqlImage)).toBe('ami-6');
    const armUbuntu = {
      ImageId: 'ami-7', OwnerId: '099720109477', Name: 'ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-arm64-server-20260701',
    };
    expect(sourceFromImage(armUbuntu)).toBe('ami-7');
  });

  it('pins an image with a publisher-style name that another account owns', () => {
    expect(sourceFromImage({
      ImageId: 'ami-8', OwnerId: '999999999999', Name: 'Windows_Server-2025-English-Full-Base-copy',
    })).toBe('ami-8');
  });
});
