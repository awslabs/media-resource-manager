// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Generates the required S3 bucket policy for cross-account DataSync access.
 * 
 * @param {string} accountId - The AWS account ID where DataSync is running
 * @param {string} bucketName - The name of the S3 bucket
 * @param {string} dataSyncRoleArn - The ARN of the DataSync IAM role
 * @returns {object} The bucket policy JSON object
 */
const generateBucketPolicy = (accountId, bucketName, dataSyncRoleArn) => {
  return {
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'DataSyncBucketAccess',
        Effect: 'Allow',
        Principal: {
          AWS: dataSyncRoleArn
        },
        Action: [
          's3:GetBucketLocation',
          's3:ListBucket',
          's3:ListBucketMultipartUploads'
        ],
        Resource: `arn:aws:s3:::${bucketName}`
      },
      {
        Sid: 'DataSyncObjectAccess',
        Effect: 'Allow',
        Principal: {
          AWS: dataSyncRoleArn
        },
        Action: [
          's3:GetObject',
          's3:GetObjectTagging',
          's3:GetObjectVersion',
          's3:GetObjectVersionTagging',
          's3:ListMultipartUploadParts'
        ],
        Resource: `arn:aws:s3:::${bucketName}/*`
      }
    ]
  };
};

/**
 * Generates the required KMS key policy for cross-account DataSync access
 * when the S3 bucket uses SSE-KMS encryption.
 * 
 * @param {string} dataSyncRoleArn - The ARN of the DataSync IAM role
 * @returns {object} The KMS key policy statement to add
 */
const generateKmsKeyPolicy = (dataSyncRoleArn) => {
  return {
    Sid: 'DataSyncKMSAccess',
    Effect: 'Allow',
    Principal: {
      AWS: dataSyncRoleArn
    },
    Action: [
      'kms:Decrypt',
      'kms:GenerateDataKey'
    ],
    Resource: '*'
  };
};

module.exports = {
  generateBucketPolicy,
  generateKmsKeyPolicy
};
