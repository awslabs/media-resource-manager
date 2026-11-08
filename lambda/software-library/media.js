// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Helpers for Software Library installer media (#54). No AWS SDK
 * dependency, so they can be checked locally.
 */

// Errors S3 returns for a missing object. HeadObject reports 404 as
// 'NotFound' only when the caller can list the bucket; otherwise S3 returns
// 403 and the object's state is unknown.
const MISSING_OBJECT_ERRORS = new Set(['NotFound', 'NoSuchKey']);

function isMissingObjectError(error) {
  return MISSING_OBJECT_ERRORS.has(error?.name) || error?.$metadata?.httpStatusCode === 404;
}

/**
 * Split s3://bucket/key. Returns null for anything else.
 */
function parseS3Uri(uri) {
  const match = /^s3:\/\/([^/]+)\/(.+)$/.exec(String(uri || ''));
  return match ? { bucket: match[1], key: match[2] } : null;
}

/**
 * Validate an installer file name from the client. It becomes the last part
 * of the S3 key, and it is placed inside a double-quoted MEDIA_PATH
 * assignment in the build script (Bash or PowerShell). So it must not
 * contain path separators, or characters those quotes don't neutralize:
 * double quote, backtick, $, or control characters. PowerShell also treats
 * the curly double quotes U+201C to U+201E as a double quote, so those (and
 * U+201F) are rejected too. Spaces and parentheses are fine.
 */
function validateMediaFileName(fileName) {
  if (typeof fileName !== 'string' || !fileName.trim()) {
    return 'fileName is required';
  }
  if (fileName.length > 255) {
    return 'fileName must be 255 characters or fewer';
  }
  if (/[\\/]/.test(fileName) || fileName === '.' || fileName === '..') {
    return 'fileName must not contain path separators';
  }
  // eslint-disable-next-line no-control-regex
  if (/["`$\u0000-\u001f\u007f\u201c-\u201f]/.test(fileName)) {
    return 'fileName must not contain quotes, backticks, $, or control characters';
  }
  return null;
}

/**
 * Validate the installer of a new library entry from the client. It must be a
 * file uploaded through POST /images/software/upload-url, which puts it in the
 * uploads bucket at software/{id}/{fileName}. Returns an error message, or
 * null.
 */
function validateUploadedMedia(mediaS3Uri, mediaFileName, uploadsBucket) {
  const fileNameError = validateMediaFileName(mediaFileName);
  if (fileNameError) return fileNameError;
  const location = parseS3Uri(mediaS3Uri);
  const key = location && /^software\/[A-Za-z0-9-]{1,64}\/(.+)$/.exec(location.key);
  if (!location || !uploadsBucket || location.bucket !== uploadsBucket || !key || key[1] !== mediaFileName) {
    return 'mediaS3Uri must be an installer uploaded to the Software Library';
  }
  return null;
}

// Same paths and commands buildComponentDocument() uses in index.js.
function mediaPaths(fileName, platform) {
  const isUnixLike = platform === 'Linux' || platform === 'macOS';
  const downloadPath = isUnixLike
    ? '/tmp/media-installer/' + fileName
    : 'C:\\Temp\\MediaInstaller\\' + fileName;
  const envSetup = isUnixLike
    ? `export MEDIA_PATH="${downloadPath}"`
    : '$env:MEDIA_PATH = "' + downloadPath + '"';
  return { downloadPath, envSetup };
}

/**
 * Point an existing component document at a new installer, keeping its
 * script and every other step unchanged. Only documents in the shape
 * buildComponentDocument() produces are supported: a DownloadMedia
 * (S3Download) step, and an InstallSoftware step whose commands set
 * MEDIA_PATH. Returns null when the document isn't in that shape.
 */
function rewriteComponentMedia(document, mediaS3Uri, mediaFileName, platform) {
  const steps = document?.phases?.find(phase => phase.name === 'build')?.steps;
  if (!Array.isArray(steps)) return null;

  const download = steps.find(step => step.name === 'DownloadMedia' && step.action === 'S3Download');
  const install = steps.find(step => step.name === 'InstallSoftware');
  const commands = install?.inputs?.commands;
  if (!Array.isArray(download?.inputs) || download.inputs.length !== 1 || !Array.isArray(commands)) {
    return null;
  }
  const mediaPathIndex = commands.findIndex(command =>
    typeof command === 'string' && /^(export MEDIA_PATH=|\$env:MEDIA_PATH = )/.test(command)
  );
  if (mediaPathIndex === -1) return null;

  const { downloadPath, envSetup } = mediaPaths(mediaFileName, platform);
  const updated = JSON.parse(JSON.stringify(document));
  const updatedSteps = updated.phases.find(phase => phase.name === 'build').steps;
  const updatedDownload = updatedSteps.find(step => step.name === 'DownloadMedia');
  updatedDownload.inputs[0] = { ...updatedDownload.inputs[0], source: mediaS3Uri, destination: downloadPath };
  updatedSteps.find(step => step.name === 'InstallSoftware').inputs.commands[mediaPathIndex] = envSetup;
  return updated;
}

module.exports = {
  isMissingObjectError,
  parseS3Uri,
  validateMediaFileName,
  validateUploadedMedia,
  mediaPaths,
  rewriteComponentMedia,
};
