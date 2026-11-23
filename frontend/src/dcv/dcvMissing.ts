// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/** Stand-in for the Amazon DCV Web Client SDK (`dcv`) when it isn't fetched; see sdkMissing.tsx. */
const dcv = { LogLevel: { TRACE: 0, DEBUG: 1, INFO: 2, WARN: 3, ERROR: 4, SILENT: 5 } };
export default dcv;
