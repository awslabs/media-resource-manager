#!/usr/bin/env python3
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

"""
Creates a multipart upload and generates presigned URLs for each part.
Run this on a machine with S3 write access to the target bucket.

Usage:
    python3 create-multipart-upload.py BUCKET
"""
import argparse
import boto3
import json
import math
import sys

key = 'adobe/creative-cloud/25.6.4/windows/amc-cc-25.6.4-2026.02.05_en_US_WIN_64.zip'
file_size_bytes = 20325553982
part_size_mb = 500
part_size_bytes = part_size_mb * 1024 * 1024


def parse_args(argv=None):
    parser = argparse.ArgumentParser(
        description='Create a multipart upload and print presigned URLs for each part.')
    parser.add_argument('bucket', help='Name of the target S3 bucket')
    return parser.parse_args(argv)


def main(argv=None):
    bucket = parse_args(argv).bucket
    s3 = boto3.client('s3')

    response = s3.create_multipart_upload(Bucket=bucket, Key=key)
    upload_id = response['UploadId']

    num_parts = math.ceil(file_size_bytes / part_size_bytes)

    print(f"Upload ID: {upload_id}", file=sys.stderr)
    print(f"Number of parts: {num_parts}", file=sys.stderr)

    parts_info = []
    for part_num in range(1, num_parts + 1):
        url = s3.generate_presigned_url(
            'upload_part',
            Params={'Bucket': bucket, 'Key': key, 'UploadId': upload_id, 'PartNumber': part_num},
            ExpiresIn=14400
        )
        start_byte = (part_num - 1) * part_size_bytes
        end_byte = min(part_num * part_size_bytes, file_size_bytes) - 1
        parts_info.append({'part_number': part_num, 'url': url, 'start_byte': start_byte, 'end_byte': end_byte})

    output = {'bucket': bucket, 'key': key, 'upload_id': upload_id, 'num_parts': num_parts, 'part_size_bytes': part_size_bytes, 'parts': parts_info}
    print(json.dumps(output, indent=2))


if __name__ == '__main__':
    main()
