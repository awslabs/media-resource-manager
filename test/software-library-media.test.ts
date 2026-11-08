// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for Software Library installer helpers (#54): validating
 * file names, detecting missing objects, and pointing an existing component
 * document at a replacement installer.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const media = require('../lambda/software-library/media.js');
const { isMissingObjectError, parseS3Uri, validateMediaFileName, validateUploadedMedia, rewriteComponentMedia } = media;

const BUCKET = 'mrm-image-builder-uploads-123456789012-us-east-1';
const OLD_URI = `s3://${BUCKET}/software/abc-123/DaVinci_Resolve_20.3.1_Linux.zip`;
const NEW_URI = `s3://${BUCKET}/software/abc-123/DaVinci_Resolve_21.1_Linux.zip`;

// Same shape buildComponentDocument() produces for an entry with media.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function componentWithMedia(platform: 'Linux' | 'Windows'): any {
  const linux = platform === 'Linux';
  const downloadPath = linux
    ? '/tmp/media-installer/DaVinci_Resolve_20.3.1_Linux.zip'
    : 'C:\\Temp\\MediaInstaller\\DaVinci_Resolve_20.3.1_Linux.zip';
  return {
    schemaVersion: '1.0',
    phases: [{
      name: 'build',
      steps: [
        { name: 'DownloadMedia', action: 'S3Download', inputs: [{ source: OLD_URI, destination: downloadPath }] },
        {
          name: 'InstallSoftware',
          action: linux ? 'ExecuteBash' : 'ExecutePowerShell',
          inputs: {
            commands: [
              linux ? `export MEDIA_PATH="${downloadPath}"` : `$env:MEDIA_PATH = "${downloadPath}"`,
              'export LICENSE_KEY="${LICENSE_KEY}"',
              '#!/bin/bash\necho install "$MEDIA_PATH"',
            ],
          },
        },
        { name: 'Cleanup', action: linux ? 'ExecuteBash' : 'ExecutePowerShell', inputs: { commands: ['rm -rf /tmp/media-installer || true'] } },
      ],
    }],
  };
}

describe('validateMediaFileName', () => {
  it('accepts typical installer names, including spaces and parentheses', () => {
    for (const name of ['DaVinci_Resolve_20.3.1_Linux.zip', 'Adobe Premiere Pro (2026).exe', 'setup-x64+codecs.msi']) {
      expect(validateMediaFileName(name)).toBeNull();
    }
  });

  it('rejects path separators and dot names', () => {
    for (const name of ['../evil.zip', 'dir/file.zip', 'dir\\file.exe', '.', '..']) {
      expect(validateMediaFileName(name)).toBe('fileName must not contain path separators');
    }
  });

  it('rejects characters that would break out of the quoted MEDIA_PATH command', () => {
    for (const name of ['a"; rm -rf ~; ".zip', 'a$(id).zip', 'a`whoami`.exe', '$env:PATH.exe', 'line\nbreak.zip']) {
      expect(validateMediaFileName(name)).toMatch(/quotes, backticks, \$, or control characters/);
    }
  });

  it('rejects the curly double quotes PowerShell treats as a double quote', () => {
    for (const name of ['Setup\u201d; Start-Process calc; \u201c.exe', 'a\u201c.exe', 'a\u201e.exe', 'a\u201f.exe']) {
      expect(validateMediaFileName(name)).toMatch(/quotes, backticks, \$, or control characters/);
    }
  });

  it('rejects missing and overlong names', () => {
    expect(validateMediaFileName(undefined)).toBe('fileName is required');
    expect(validateMediaFileName('   ')).toBe('fileName is required');
    expect(validateMediaFileName(`${'x'.repeat(252)}.zip`)).toBe('fileName must be 255 characters or fewer');
  });
});

describe('validateUploadedMedia', () => {
  const NAME = 'DaVinci_Resolve_20.3.1_Linux.zip';
  const LOCATION_ERROR = 'mediaS3Uri must be an installer uploaded to the Software Library';

  it('accepts a file uploaded to software/{id}/{fileName} in the uploads bucket', () => {
    expect(validateUploadedMedia(OLD_URI, NAME, BUCKET)).toBeNull();
  });

  it('rejects an invalid file name before checking the location', () => {
    expect(validateUploadedMedia(`s3://${BUCKET}/software/abc-123/a$b.zip`, 'a$b.zip', BUCKET))
      .toMatch(/quotes, backticks, \$, or control characters/);
    expect(validateUploadedMedia(OLD_URI, undefined, BUCKET)).toBe('fileName is required');
  });

  it('rejects files outside the uploads bucket or the software/{id}/ prefix', () => {
    for (const uri of [
      `s3://other-bucket/software/abc-123/${NAME}`,
      `s3://${BUCKET}/${NAME}`,
      `s3://${BUCKET}/other/abc-123/${NAME}`,
      `s3://${BUCKET}/software/${NAME}`,
      `s3://${BUCKET}/software/abc_123/${NAME}`,
      `s3://${BUCKET}/software/abc-123/nested/${NAME}`,
      `https://example.com/${NAME}`,
      undefined,
    ]) {
      expect(validateUploadedMedia(uri, NAME, BUCKET)).toBe(LOCATION_ERROR);
    }
  });

  it('rejects a location whose file name differs from mediaFileName', () => {
    expect(validateUploadedMedia(OLD_URI, 'Other.zip', BUCKET)).toBe(LOCATION_ERROR);
  });

  it('rejects everything when the uploads bucket is not configured', () => {
    expect(validateUploadedMedia(OLD_URI, NAME, undefined)).toBe(LOCATION_ERROR);
  });
});

describe('parseS3Uri', () => {
  it('splits bucket and key', () => {
    expect(parseS3Uri(OLD_URI)).toEqual({ bucket: BUCKET, key: 'software/abc-123/DaVinci_Resolve_20.3.1_Linux.zip' });
  });

  it('returns null for anything that is not an s3:// URI with a key', () => {
    for (const value of ['', undefined, 'https://example.com/a', `s3://${BUCKET}`, `s3://${BUCKET}/`]) {
      expect(parseS3Uri(value)).toBeNull();
    }
  });
});

describe('isMissingObjectError', () => {
  it('treats NotFound, NoSuchKey, and HTTP 404 as missing', () => {
    expect(isMissingObjectError({ name: 'NotFound' })).toBe(true);
    expect(isMissingObjectError({ name: 'NoSuchKey' })).toBe(true);
    expect(isMissingObjectError({ name: 'Unknown', $metadata: { httpStatusCode: 404 } })).toBe(true);
  });

  it('does not treat permission errors or throttling as missing', () => {
    expect(isMissingObjectError({ name: 'Forbidden', $metadata: { httpStatusCode: 403 } })).toBe(false);
    expect(isMissingObjectError({ name: 'SlowDown', $metadata: { httpStatusCode: 503 } })).toBe(false);
  });
});

describe('rewriteComponentMedia', () => {
  it('points a Linux component at the new installer and keeps the script', () => {
    const before = componentWithMedia('Linux');
    const after = rewriteComponentMedia(before, NEW_URI, 'DaVinci_Resolve_21.1_Linux.zip', 'Linux');
    const steps = after.phases[0].steps;
    expect(steps[0].inputs[0]).toEqual({ source: NEW_URI, destination: '/tmp/media-installer/DaVinci_Resolve_21.1_Linux.zip' });
    expect(steps[1].inputs.commands[0]).toBe('export MEDIA_PATH="/tmp/media-installer/DaVinci_Resolve_21.1_Linux.zip"');
    expect(steps[1].inputs.commands.slice(1)).toEqual(before.phases[0].steps[1].inputs.commands.slice(1));
    expect(steps[2]).toEqual(before.phases[0].steps[2]);
  });

  it('uses the Windows download path and MEDIA_PATH syntax for Windows components', () => {
    const after = rewriteComponentMedia(componentWithMedia('Windows'), NEW_URI, 'Setup.exe', 'Windows');
    expect(after.phases[0].steps[0].inputs[0].destination).toBe('C:\\Temp\\MediaInstaller\\Setup.exe');
    expect(after.phases[0].steps[1].inputs.commands[0]).toBe('$env:MEDIA_PATH = "C:\\Temp\\MediaInstaller\\Setup.exe"');
  });

  it('does not modify the original document', () => {
    const before = componentWithMedia('Linux');
    const snapshot = JSON.stringify(before);
    rewriteComponentMedia(before, NEW_URI, 'new.zip', 'Linux');
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it('returns null for documents it does not recognize', () => {
    const noMedia = {
      phases: [{ name: 'build', steps: [{ name: 'InstallSoftware', action: 'ExecuteBash', inputs: { commands: ['echo hi'] } }] }],
    };
    expect(rewriteComponentMedia(noMedia, NEW_URI, 'new.zip', 'Linux')).toBeNull();
    const noMediaPath = componentWithMedia('Linux');
    noMediaPath.phases[0].steps[1].inputs.commands.shift();
    expect(rewriteComponentMedia(noMediaPath, NEW_URI, 'new.zip', 'Linux')).toBeNull();
    expect(rewriteComponentMedia(null, NEW_URI, 'new.zip', 'Linux')).toBeNull();
  });
});
