// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// The Software Library uploads an installer in one PUT to a pre-signed S3 URL,
// and S3 accepts at most 5 GB in a single PUT. Larger files need a multipart
// upload (#56); until then they're rejected before the upload starts.
const GB = 1024 * 1024 * 1024;
export const MAX_SINGLE_UPLOAD_BYTES = 5 * GB;

// Rounded up, so a file just over the limit doesn't read as "5.0 GB".
const formatGb = (bytes: number) => `${(Math.ceil((bytes / GB) * 10) / 10).toFixed(1)} GB`;

// Returns an error message when the installer is too large to upload, or null.
export const installerTooLargeMessage = (file: File): string | null =>
  file.size > MAX_SINGLE_UPLOAD_BYTES
    ? `${file.name} is ${formatGb(file.size)}. Installers uploaded here can be at most 5 GB. ` +
      'For a larger installer, have your installation script download it from the vendor.'
    : null;
