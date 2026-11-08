// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for Image Builder resource naming (#48).
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const naming = require('../lambda/image-manager/naming.js');
const {
  RESOURCE_NAME_MAX_LENGTH,
  DISPLAY_NAME_MAX_LENGTH,
  validateDisplayName,
  toImageBuilderName,
  toComponentName,
  toAmiNameBase,
  buildImageMatchPatterns,
  imageMatchesAnyPattern,
} = naming;

// Patterns from the EC2 Image Builder API reference.
const RESOURCE_NAME_PATTERN = /^[-_A-Za-z-0-9][-_A-Za-z0-9 ]{1,126}[-_A-Za-z-0-9]$/;
const AMI_NAME_PATTERN = /^[-_A-Za-z0-9{][-_A-Za-z0-9\s:{}.]+[-_A-Za-z0-9}]$/;

const PIPELINE_ID = 'abcd1234-5678-90ab-cdef-1234567890ab';
const KINDS = ['infra', 'dist', 'recipe', 'pipeline'];

describe('toImageBuilderName', () => {
  it('replaces characters Image Builder rejects, such as / and parentheses', () => {
    const name = toImageBuilderName('mrm', 'Test pipeline 10/28/2026 (v2)', 'infra', PIPELINE_ID);
    expect(name).toBe('mrm-Test pipeline 10-28-2026-v2-infra-abcd1234');
    expect(name).toMatch(RESOURCE_NAME_PATTERN);
  });

  it('leaves names made of allowed characters unchanged, as before #48', () => {
    expect(toImageBuilderName('mrm', 'Media Workstation_Pipeline-2', 'recipe', PIPELINE_ID))
      .toBe('mrm-Media Workstation_Pipeline-2-recipe-abcd1234');
  });

  it('trims separators from both ends and collapses repeated separators', () => {
    expect(toImageBuilderName('mrm', '  --My   Pipeline//__  ', 'dist', PIPELINE_ID))
      .toBe('mrm-My Pipeline-dist-abcd1234');
    expect(toImageBuilderName('mrm', 'a // b', 'dist', PIPELINE_ID)).toBe('mrm-a-b-dist-abcd1234');
  });

  it('replaces non-ASCII characters', () => {
    const name = toImageBuilderName('mrm', 'Café Édit', 'pipeline', PIPELINE_ID);
    expect(name).toBe('mrm-Caf-dit-pipeline-abcd1234');
    expect(name).toMatch(RESOURCE_NAME_PATTERN);
  });

  it('keeps the acronym prefix and the kind/id suffix when truncating', () => {
    const name = toImageBuilderName('mrm', 'x'.repeat(300), 'pipeline', PIPELINE_ID);
    expect(name.length).toBe(RESOURCE_NAME_MAX_LENGTH);
    expect(name.startsWith('mrm-x')).toBe(true);
    expect(name.endsWith('-pipeline-abcd1234')).toBe(true);
    expect(name).toMatch(RESOURCE_NAME_PATTERN);
  });

  it('does not leave a separator at the cut point when truncating', () => {
    // Put a space exactly where the middle part gets cut.
    const room = RESOURCE_NAME_MAX_LENGTH - 'mrm-'.length - '-infra-abcd1234'.length;
    const displayName = `${'a'.repeat(room - 1)} tail`;
    const name = toImageBuilderName('mrm', displayName, 'infra', PIPELINE_ID);
    expect(name).toBe(`mrm-${'a'.repeat(room - 1)}-infra-abcd1234`);
    expect(name).toMatch(RESOURCE_NAME_PATTERN);
  });

  it('keeps every resource name valid for the longest display name the API accepts', () => {
    const longest = 'Adobe Premiere/After Effects (2026) '.repeat(10).slice(0, DISPLAY_NAME_MAX_LENGTH);
    for (const kind of KINDS) {
      const name = toImageBuilderName('mrm', longest, kind, PIPELINE_ID);
      expect(name.length).toBeLessThanOrEqual(RESOURCE_NAME_MAX_LENGTH);
      expect(name).toMatch(RESOURCE_NAME_PATTERN);
    }
  });

  it('throws when nothing usable is left after cleanup', () => {
    expect(() => toImageBuilderName('mrm', '///', 'infra', PIPELINE_ID)).toThrow(/letter or number/);
    expect(() => toImageBuilderName('mrm', '', 'infra', PIPELINE_ID)).toThrow(/letter or number/);
  });
});

describe('toComponentName', () => {
  it('cleans the script name and keeps the pipelineId suffix', () => {
    const name = toComponentName('Install Codecs (v2)', PIPELINE_ID);
    expect(name).toBe('Install Codecs-v2-abcd1234');
    expect(name).toMatch(RESOURCE_NAME_PATTERN);
  });

  it('stays within 128 characters', () => {
    const name = toComponentName('Configure/'.repeat(30), PIPELINE_ID);
    expect(name.length).toBeLessThanOrEqual(RESOURCE_NAME_MAX_LENGTH);
    expect(name).toMatch(RESOURCE_NAME_PATTERN);
  });
});

describe('toAmiNameBase', () => {
  it('produces a valid distribution AMI name, keeping dots', () => {
    const base = toAmiNameBase('Premiere 25.1 (10/28/2026)');
    expect(base).toBe('Premiere 25.1-10-28-2026');
    expect(`${base}-{{imagebuilder:buildDate}}`).toMatch(AMI_NAME_PATTERN);
  });

  it('removes braces so a display name cannot inject an Image Builder variable', () => {
    const base = toAmiNameBase('{{imagebuilder:buildDate}}');
    expect(base).not.toMatch(/[{}]/);
    expect(`${base}-{{imagebuilder:buildDate}}`).toMatch(AMI_NAME_PATTERN);
  });

  it('caps the display-name part at 100 characters', () => {
    expect(toAmiNameBase('y'.repeat(300)).length).toBe(100);
  });
});

describe('validateDisplayName', () => {
  it('accepts names with characters that get replaced', () => {
    expect(validateDisplayName('Test pipeline 10/28/2026 (v2)', 'Pipeline name')).toBeNull();
  });

  it('rejects missing, blank, and non-string names', () => {
    for (const value of [undefined, null, '', '   ', 42]) {
      expect(validateDisplayName(value, 'Pipeline name')).toBe('Pipeline name is required.');
    }
  });

  it('rejects names with no letter or number', () => {
    expect(validateDisplayName('/// ()', 'Pipeline name'))
      .toBe('Pipeline name must contain at least one letter or number.');
  });

  it('rejects names longer than the API limit', () => {
    expect(validateDisplayName('z'.repeat(DISPLAY_NAME_MAX_LENGTH), 'Pipeline name')).toBeNull();
    expect(validateDisplayName('z'.repeat(DISPLAY_NAME_MAX_LENGTH + 1), 'Pipeline name'))
      .toBe(`Pipeline name must be ${DISPLAY_NAME_MAX_LENGTH} characters or fewer.`);
  });
});

describe('image matching for pipeline deletion', () => {
  it('matches images of a pipeline created before #48 (mixed case, spaces)', () => {
    const patterns = buildImageMatchPatterns({
      pipelineId: 'bff2eb2d-0000-0000-0000-000000000000',
      imageRecipeArn: 'arn:aws:imagebuilder:us-east-1:123456789012:image-recipe/mrm-media-workstation-recipe-bff2eb2d/1.0.3',
      displayName: 'Media Workstation',
    });
    expect(imageMatchesAnyPattern('mrm-media-workstation-recipe-bff2eb2d', patterns)).toBe(true);
    expect(imageMatchesAnyPattern('mrm-Media Workstation-recipe-bff2eb2d', patterns)).toBe(true);
  });

  it('matches images of a pipeline created after #48 with a cleaned-up name', () => {
    const patterns = buildImageMatchPatterns({
      pipelineId: PIPELINE_ID,
      imageRecipeArn: 'arn:aws:imagebuilder:us-east-1:123456789012:image-recipe/mrm-test-pipeline-10-28-2026-v2-recipe-abcd1234/1.0.0',
      displayName: 'Test pipeline 10/28/2026 (v2)',
    });
    expect(imageMatchesAnyPattern('mrm-test-pipeline-10-28-2026-v2-recipe-abcd1234', patterns)).toBe(true);
    expect(imageMatchesAnyPattern('mrm-Test pipeline 10-28-2026-v2-recipe-abcd1234', patterns)).toBe(true);
  });

  it('does not match an unrelated pipeline image', () => {
    const patterns = buildImageMatchPatterns({
      pipelineId: PIPELINE_ID,
      imageRecipeArn: 'arn:aws:imagebuilder:us-east-1:123456789012:image-recipe/mrm-render-node-recipe-abcd1234/1.0.0',
      displayName: 'Render Node',
    });
    expect(imageMatchesAnyPattern('mrm-editing-suite-recipe-99999999', patterns)).toBe(false);
  });
});
