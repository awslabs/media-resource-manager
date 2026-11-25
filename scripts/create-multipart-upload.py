#!/usr/bin/env python3
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

"""
Creates a multipart upload and generates presigned URLs for each part.
Run this on a machine with S3 write access to the target bucket.

Usage:
    python3 create-multipart-upload.py BUCKET KEY FILE_SIZE_BYTES [--part-size MB]
"""
import argparse
import boto3
import json
import math
import sys

DEFAULT_PART_SIZE_MB = 500
# S3 multipart limits: parts of at least 5 MiB (except the last), at most 10,000 parts
MIN_PART_SIZE_MB = 5
MAX_PARTS = 10000


def positive_int(value):
    number = int(value)
    if number <= 0:
        raise argparse.ArgumentTypeError(f'must be a positive integer: {value}')
    return number


def parse_args(argv=None):
    parser = argparse.ArgumentParser(
        description='Create a multipart upload and print presigned URLs for each part.')
    parser.add_argument('bucket', help='Name of the target S3 bucket')
    parser.add_argument('key', help='Object key to upload to')
    parser.add_argument('file_size_bytes', type=positive_int, help='Size of the file to upload, in bytes')
    parser.add_argument('--part-size', dest='part_size_mb', type=positive_int, default=DEFAULT_PART_SIZE_MB,
                        metavar='MB', help=f'Part size in MiB (default: {DEFAULT_PART_SIZE_MB})')
    args = parser.parse_args(argv)
    if args.part_size_mb < MIN_PART_SIZE_MB:
        parser.error(f'--part-size must be at least {MIN_PART_SIZE_MB} MB')
    if math.ceil(args.file_size_bytes / (args.part_size_mb * 1024 * 1024)) > MAX_PARTS:
        parser.error(f'more than {MAX_PARTS} parts; use a larger --part-size')
    return args


def main(argv=None):
    args = parse_args(argv)
    bucket = args.bucket
    key = args.key
    file_size_bytes = args.file_size_bytes
    part_size_bytes = args.part_size_mb * 1024 * 1024

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
