// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Builds EC2 Image Builder resource names from user-entered display names.
 *
 * Image Builder resource names (infrastructure configuration, distribution
 * configuration, recipe, pipeline, component) must match
 *   ^[-_A-Za-z-0-9][-_A-Za-z0-9 ]{1,126}[-_A-Za-z-0-9]$
 * which means 3-128 characters of letters, digits, '-' and '_', with spaces
 * allowed only in the middle. Output AMI names in a distribution
 * configuration use a looser pattern that also allows '.' and ':'. A display
 * name such as "Test pipeline 10/28/2026" breaks both, and Image Builder
 * rejects the request with "The ARN format is invalid" (#48).
 *
 * These helpers only change the AWS resource names. The display name the
 * user typed is stored in DynamoDB and shown in the UI unchanged.
 *
 * This module has no AWS SDK dependency so the unit tests can load it.
 */

const RESOURCE_NAME_MAX_LENGTH = 128;

// Distribution AMI names must contain {{imagebuilder:buildDate}}, which
// expands to about 27 characters, and EC2 caps AMI names at 128. Keep the
// part derived from the display name at 100 characters or fewer.
const AMI_NAME_BASE_MAX_LENGTH = 100;

// Longest display name the API accepts. The UI limits input to 100.
const DISPLAY_NAME_MAX_LENGTH = 128;

const RESOURCE_NAME_DISALLOWED = /[^A-Za-z0-9 _-]+/g;
const AMI_NAME_DISALLOWED = /[^A-Za-z0-9 _.:-]+/g;
const EDGE_SEPARATORS = /^[ _.:-]+|[ _.:-]+$/g;

/**
 * Replace disallowed characters with '-', collapse repeated separators, and
 * trim separators from both ends. Returns '' when nothing usable is left.
 * Because both ends are trimmed of separators, a non-empty result always
 * starts and ends with a letter or digit.
 */
function cleanNamePart(value, disallowed) {
  return String(value ?? '')
    .replace(disallowed, '-')   // each run of disallowed characters becomes one '-'
    .replace(/ *-[ -]*/g, '-')  // a '-' plus any spaces or '-' around it becomes one '-'
    .replace(/ {2,}/g, ' ')     // repeated spaces become one space
    .replace(EDGE_SEPARATORS, '');
}

function truncate(value, maxLength) {
  if (value.length <= maxLength) {
    return value;
  }
  // Re-trim so the cut never leaves a trailing space or separator.
  return value.slice(0, maxLength).replace(EDGE_SEPARATORS, '');
}

/**
 * Validate a display name at the API boundary. Returns an error message, or
 * null when the name is usable.
 */
function validateDisplayName(displayName, label = 'Name') {
  if (typeof displayName !== 'string' || displayName.trim() === '') {
    return `${label} is required.`;
  }
  if (displayName.length > DISPLAY_NAME_MAX_LENGTH) {
    return `${label} must be ${DISPLAY_NAME_MAX_LENGTH} characters or fewer.`;
  }
  if (!cleanNamePart(displayName, RESOURCE_NAME_DISALLOWED)) {
    return `${label} must contain at least one letter or number.`;
  }
  return null;
}

function buildImageBuilderName(prefix, displayName, suffix) {
  const core = cleanNamePart(displayName, RESOURCE_NAME_DISALLOWED);
  if (!core) {
    throw new Error('Name must contain at least one letter or number.');
  }
  const room = RESOURCE_NAME_MAX_LENGTH - prefix.length - suffix.length;
  return `${prefix}${truncate(core, room)}${suffix}`;
}

/**
 * Name for a pipeline-scoped Image Builder resource:
 *   {acronym}-{cleaned display name}-{kind}-{first 8 chars of pipelineId}
 *
 * The '{acronym}-' prefix is what log-group cleanup matches
 * (/aws/imagebuilder/{acronym}-*). The '-{kind}-{id}' suffix keeps names
 * unique per pipeline. Only the middle part is truncated.
 */
function toImageBuilderName(acronym, displayName, kind, pipelineId) {
  return buildImageBuilderName(
    `${acronym}-`,
    displayName,
    `-${kind}-${String(pipelineId).substring(0, 8)}`
  );
}

/**
 * Name for a custom-script component: {cleaned script name}-{pipelineId[0:8]}.
 * Same shape as before #48, just cleaned up.
 */
function toComponentName(displayName, pipelineId) {
  return buildImageBuilderName('', displayName, `-${String(pipelineId).substring(0, 8)}`);
}

/**
 * The display-name part of a distribution AMI name. Callers append
 * '-{{imagebuilder:buildDate}}'. Braces are not allowed here, so a display
 * name can never inject its own Image Builder template variable.
 */
function toAmiNameBase(displayName) {
  const core = cleanNamePart(displayName, AMI_NAME_DISALLOWED);
  if (!core) {
    throw new Error('Name must contain at least one letter or number.');
  }
  return truncate(core, AMI_NAME_BASE_MAX_LENGTH);
}

/**
 * Lowercase substrings used to find the Image Builder images that belong to a
 * pipeline when it is deleted. Image names follow the recipe name, so any of
 * these can match. Pipelines created before and after #48 both match because
 * the recipe name and the pipelineId prefix are always present.
 */
function buildImageMatchPatterns({ pipelineId, imageRecipeArn, displayName }) {
  const patterns = [];

  // Recipe name from the ARN: arn:aws:imagebuilder:region:account:image-recipe/name/version
  const recipeName = imageRecipeArn ? imageRecipeArn.split('/')[1] : undefined;
  if (recipeName) {
    patterns.push(recipeName.toLowerCase());
  }

  const pipelineIdPrefix = pipelineId ? String(pipelineId).substring(0, 8) : '';
  if (pipelineIdPrefix) {
    patterns.push(pipelineIdPrefix.toLowerCase());
  }

  if (displayName) {
    patterns.push(displayName.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-'));
  }

  return patterns;
}

function imageMatchesAnyPattern(imageName, patterns) {
  const name = (imageName || '').toLowerCase();
  return patterns.some(pattern => name.includes(pattern));
}

module.exports = {
  RESOURCE_NAME_MAX_LENGTH,
  AMI_NAME_BASE_MAX_LENGTH,
  DISPLAY_NAME_MAX_LENGTH,
  validateDisplayName,
  toImageBuilderName,
  toComponentName,
  toAmiNameBase,
  buildImageMatchPatterns,
  imageMatchesAnyPattern,
};
