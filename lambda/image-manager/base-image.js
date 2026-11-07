// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Base image tracking for user pipelines (#49).
 *
 * A pipeline's base image has a source and a current AMI:
 *   - baseImageSource: what the admin chose. Either a symbolic ID for a
 *     built-in base ('windows-2025', 'rocky-8', ...) or an AMI ID for a
 *     custom or golden-image base.
 *   - baseImageId: the AMI the current recipe version uses.
 *
 * Symbolic sources follow the latest AWS AMI for that family, so a pipeline
 * keeps working after AWS retires the AMI it was created with. AMI-ID sources
 * stay pinned and are never swapped automatically.
 *
 * Every AWS call is passed in through `deps` so this module has no SDK
 * dependency and the lookup order can be unit tested.
 */

// Built-in base images offered in the pipeline creation UI, and how to find
// the latest AMI for each one.
const BASE_IMAGE_SOURCES = {
  'windows-2025': {
    label: 'Windows Server 2025',
    ssmParameter: '/aws/service/ami-windows-latest/Windows_Server-2025-English-Full-Base',
  },
  'windows-2022': {
    label: 'Windows Server 2022',
    ssmParameter: '/aws/service/ami-windows-latest/Windows_Server-2022-English-Full-Base',
  },
  'windows-2019': {
    label: 'Windows Server 2019',
    ssmParameter: '/aws/service/ami-windows-latest/Windows_Server-2019-English-Full-Base',
  },
  'ubuntu-22.04': {
    label: 'Ubuntu 22.04',
    ssmParameter: '/aws/service/canonical/ubuntu/server/22.04/stable/current/amd64/hvm/ebs-gp2/ami-id',
  },
  'rocky-8': {
    label: 'Rocky Linux 8',
    // Rocky 8 is required for DaVinci Resolve compatibility
    describeImages: { owner: '792107900819', namePattern: 'Rocky-8-EC2-Base-8*x86_64*' },
  },
  'rocky-9': {
    label: 'Rocky Linux 9',
    describeImages: { owner: '792107900819', namePattern: 'Rocky-9-EC2-Base-9*x86_64*' },
  },
};

// For pipeline records that predate baseImageSource and have no BaseImage tag:
// map a publisher-owned AMI back to its family by owner and AMI name.
const PUBLISHER_FAMILIES = [
  { source: 'windows-2025', ownerIds: ['801119661308'], ownerAlias: 'amazon', namePattern: /^Windows_Server-2025-English-Full-Base-/ },
  { source: 'windows-2022', ownerIds: ['801119661308'], ownerAlias: 'amazon', namePattern: /^Windows_Server-2022-English-Full-Base-/ },
  { source: 'windows-2019', ownerIds: ['801119661308'], ownerAlias: 'amazon', namePattern: /^Windows_Server-2019-English-Full-Base-/ },
  { source: 'ubuntu-22.04', ownerIds: ['099720109477'], namePattern: /^ubuntu\/images\/hvm-ssd(-gp3)?\/ubuntu-jammy-22\.04-amd64-server-/ },
  { source: 'rocky-8', ownerIds: ['792107900819'], namePattern: /^Rocky-8-EC2-Base-8\..*x86_64/ },
  { source: 'rocky-9', ownerIds: ['792107900819'], namePattern: /^Rocky-9-EC2-Base-9\..*x86_64/ },
];

const UNUSABLE_IMAGE_STATES = new Set(['deregistered', 'disabled', 'failed', 'error', 'invalid']);

/**
 * Raised when a pipeline's base image cannot be used. Handlers return it to
 * the caller as HTTP 409 with the message unchanged.
 */
class BaseImageError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'BaseImageError';
    this.code = code;
    this.statusCode = 409;
  }
}

function isSymbolicSource(source) {
  return Object.prototype.hasOwnProperty.call(BASE_IMAGE_SOURCES, source);
}

function isAmiId(value) {
  return typeof value === 'string' && /^ami-[0-9a-f]{8,17}$/.test(value);
}

function isImageUsable(image) {
  return Boolean(image) && !UNUSABLE_IMAGE_STATES.has(image.State);
}

/**
 * Map an existing AMI to a source. Returns a symbolic ID for a known
 * publisher image, or the AMI ID itself (pinned) for anything else: images
 * this account owns, images shared from another account, and publisher
 * images outside the built-in families. Pinning keeps today's behavior and
 * never swaps the base.
 */
function sourceFromImage(image) {
  const name = image.Name || '';
  const family = PUBLISHER_FAMILIES.find(candidate =>
    (candidate.ownerIds.includes(image.OwnerId) ||
      (candidate.ownerAlias && image.ImageOwnerAlias === candidate.ownerAlias)) &&
    candidate.namePattern.test(name)
  );
  return family ? family.source : image.ImageId;
}

/**
 * Work out baseImageSource for a pipeline record that does not have one.
 * Lookup order:
 *   1. The BaseImage tag on the pipeline's distribution configuration. Every
 *      MRM version sets it to the symbolic ID (or the AMI ID for custom
 *      bases), and it survives after the AMI is retired.
 *   2. The stored AMI itself, if it still exists.
 *   3. Otherwise fail. Never infer the source from baseOsVersion, which also
 *      says "Windows Server 2025" for custom images built on that OS.
 *
 * @param {{ baseImageId?: string, distributionConfigurationArn?: string }} pipeline
 * @param {{ getDistributionBaseImageTag: Function, describeImage: Function }} deps
 * @returns {Promise<{ source: string, detectedBy: 'tag' | 'ami' }>}
 */
async function detectBaseImageSource(pipeline, deps) {
  const tag = await deps.getDistributionBaseImageTag(pipeline.distributionConfigurationArn);
  if (isSymbolicSource(tag) || isAmiId(tag)) {
    return { source: tag, detectedBy: 'tag' };
  }

  if (pipeline.baseImageId) {
    const image = await deps.describeImage(pipeline.baseImageId);
    if (isImageUsable(image)) {
      return { source: sourceFromImage(image), detectedBy: 'ami' };
    }
  }

  throw new BaseImageError(
    `Base image ${pipeline.baseImageId || '(unknown)'} for this pipeline no longer exists, and MRM could not determine ` +
      'which base image it was created from. Create a new pipeline with a current base image.',
    'BASE_IMAGE_SOURCE_UNKNOWN'
  );
}

/**
 * Decide which AMI the pipeline's next recipe should use.
 *
 * @param {{ baseImageSource?: string, baseImageId?: string, distributionConfigurationArn?: string }} pipeline
 * @param {{ getDistributionBaseImageTag: Function, describeImage: Function, resolveLatestAmi: Function }} deps
 * @returns {Promise<{ source: string, sourceWasDetected: boolean, amiId: string,
 *                     previousAmiId: string | undefined, changed: boolean }>}
 */
async function resolvePipelineBase(pipeline, deps) {
  let source = pipeline.baseImageSource;
  let sourceWasDetected = false;
  if (!source) {
    ({ source } = await detectBaseImageSource(pipeline, deps));
    sourceWasDetected = true;
  }

  const previousAmiId = pipeline.baseImageId;
  let amiId;
  if (isSymbolicSource(source)) {
    amiId = await deps.resolveLatestAmi(source);
  } else {
    // Pinned custom or golden image. Check it still exists so the caller gets
    // a clear error instead of Image Builder's ResourceNotFoundException.
    const image = await deps.describeImage(source);
    if (!isImageUsable(image)) {
      throw new BaseImageError(
        `Base image ${source} no longer exists. This pipeline uses a custom base image, which MRM never replaces ` +
          'automatically. Create a new pipeline with a current base image.',
        'BASE_IMAGE_UNAVAILABLE'
      );
    }
    amiId = source;
  }

  return { source, sourceWasDetected, amiId, previousAmiId, changed: amiId !== previousAmiId };
}

module.exports = {
  BASE_IMAGE_SOURCES,
  BaseImageError,
  isSymbolicSource,
  isAmiId,
  isImageUsable,
  sourceFromImage,
  detectBaseImageSource,
  resolvePipelineBase,
};
