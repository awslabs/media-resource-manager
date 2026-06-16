#!/usr/bin/env python3
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

"""
Multipart S3 Upload Orchestrator

This script orchestrates a multipart upload to S3 by:
1. Creating a multipart upload
2. Generating presigned URLs for each part
3. Outputting commands to upload each part
4. Completing the multipart upload after all parts are uploaded

Usage:
    python3 multipart-s3-upload.py create <bucket> <key> <file_size_bytes> [--part-size MB]
    python3 multipart-s3-upload.py complete <bucket> <key> <upload_id> <parts_json>
"""

import boto3
import json
import sys
import math

def create_multipart_upload(bucket, key, file_size_bytes, part_size_mb=100):
    """Create multipart upload and generate presigned URLs for all parts."""
    s3 = boto3.client('s3')
    
    # Create multipart upload
    response = s3.create_multipart_upload(Bucket=bucket, Key=key)
    upload_id = response['UploadId']
    
    part_size_bytes = part_size_mb * 1024 * 1024
    num_parts = math.ceil(file_size_bytes / part_size_bytes)
    
    print(f"Upload ID: {upload_id}")
    print(f"File size: {file_size_bytes} bytes ({file_size_bytes / (1024**3):.2f} GB)")
    print(f"Part size: {part_size_mb} MB")
    print(f"Number of parts: {num_parts}")
    print()
    
    # Generate presigned URLs for each part
    parts_info = []
    for part_num in range(1, num_parts + 1):
        url = s3.generate_presigned_url(
            'upload_part',
            Params={
                'Bucket': bucket,
                'Key': key,
                'UploadId': upload_id,
                'PartNumber': part_num
            },
            ExpiresIn=14400  # 4 hours
        )
        
        start_byte = (part_num - 1) * part_size_bytes
        end_byte = min(part_num * part_size_bytes, file_size_bytes) - 1
        
        parts_info.append({
            'part_number': part_num,
            'url': url,
            'start_byte': start_byte,
            'end_byte': end_byte,
            'size': end_byte - start_byte + 1
        })
    
    # Output JSON with all info needed
    output = {
        'bucket': bucket,
        'key': key,
        'upload_id': upload_id,
        'part_size_bytes': part_size_bytes,
        'num_parts': num_parts,
        'parts': parts_info
    }
    
    print("=== UPLOAD INFO (save this) ===")
    print(json.dumps(output, indent=2))
    
    return output


def complete_multipart_upload(bucket, key, upload_id, parts_etags):
    """Complete the multipart upload with ETags from uploaded parts."""
    s3 = boto3.client('s3')
    
    # parts_etags should be a list of {'PartNumber': N, 'ETag': 'xxx'}
    response = s3.complete_multipart_upload(
        Bucket=bucket,
        Key=key,
        UploadId=upload_id,
        MultipartUpload={'Parts': parts_etags}
    )
    
    print(f"Upload completed successfully!")
    print(f"Location: {response.get('Location')}")
    print(f"ETag: {response.get('ETag')}")
    return response


def abort_multipart_upload(bucket, key, upload_id):
    """Abort a multipart upload."""
    s3 = boto3.client('s3')
    s3.abort_multipart_upload(Bucket=bucket, Key=key, UploadId=upload_id)
    print(f"Upload {upload_id} aborted.")


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    
    action = sys.argv[1]
    
    if action == 'create':
        if len(sys.argv) < 5:
            print("Usage: python3 multipart-s3-upload.py create <bucket> <key> <file_size_bytes> [--part-size MB]")
            sys.exit(1)
        bucket = sys.argv[2]
        key = sys.argv[3]
        file_size = int(sys.argv[4])
        part_size = 100  # default 100MB parts
        if '--part-size' in sys.argv:
            idx = sys.argv.index('--part-size')
            part_size = int(sys.argv[idx + 1])
        create_multipart_upload(bucket, key, file_size, part_size)
    
    elif action == 'complete':
        if len(sys.argv) < 6:
            print("Usage: python3 multipart-s3-upload.py complete <bucket> <key> <upload_id> <parts_json>")
            sys.exit(1)
        bucket = sys.argv[2]
        key = sys.argv[3]
        upload_id = sys.argv[4]
        parts_json = sys.argv[5]
        parts = json.loads(parts_json)
        complete_multipart_upload(bucket, key, upload_id, parts)
    
    elif action == 'abort':
        if len(sys.argv) < 5:
            print("Usage: python3 multipart-s3-upload.py abort <bucket> <key> <upload_id>")
            sys.exit(1)
        bucket = sys.argv[2]
        key = sys.argv[3]
        upload_id = sys.argv[4]
        abort_multipart_upload(bucket, key, upload_id)
    
    else:
        print(f"Unknown action: {action}")
        print(__doc__)
        sys.exit(1)
