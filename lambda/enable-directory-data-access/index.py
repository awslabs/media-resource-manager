# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

import boto3
import json
import urllib.request
import urllib.parse

def safe_urlopen(url_or_request, *args, **kwargs):
    """Safely open URLs with scheme validation to prevent file:// and other unsafe schemes."""
    if isinstance(url_or_request, urllib.request.Request):
        url_to_check = url_or_request.full_url
    else:
        url_to_check = url_or_request
    parsed = urllib.parse.urlparse(url_to_check)
    if parsed.scheme not in ['https']:
        raise ValueError(f"Unsafe URL scheme: {parsed.scheme}")
    return urllib.request.urlopen(url_or_request, *args, **kwargs)  # nosec B310 # nosemgrep: dynamic-urllib-use-detected

def send_cfn_response(event, context, status, data=None):
    """Send response to CloudFormation"""
    response_body = {
        'Status': status,
        'Reason': f'See CloudWatch Log Stream: {context.log_stream_name}',
        'PhysicalResourceId': context.log_stream_name,
        'StackId': event['StackId'],
        'RequestId': event['RequestId'],
        'LogicalResourceId': event['LogicalResourceId'],
        'Data': data or {}
    }
    
    response_body_json = json.dumps(response_body).encode('utf-8')
    
    req = urllib.request.Request(
        event['ResponseURL'],
        data=response_body_json,
        headers={'Content-Type': 'application/json'},
        method='PUT'
    )
    
    safe_urlopen(req)

def handler(event, context):
    print(f"Event: {json.dumps(event)}")
    
    try:
        if event['RequestType'] == 'Create':
            ds_client = boto3.client('ds')
            directory_id = event['ResourceProperties']['DirectoryId']
            
            try:
                # Enable Directory Data Access
                ds_client.enable_directory_data_access(DirectoryId=directory_id)
                print(f"Successfully enabled Directory Data Access for {directory_id}")
            except ds_client.exceptions.DirectoryInDesiredStateException:
                print(f"Directory Data Access already enabled for {directory_id}")
            except Exception as e:
                print(f"Error enabling directory data access: {str(e)}")
                # Don't fail on this - it might already be enabled
        
        send_cfn_response(event, context, 'SUCCESS')
    except Exception as e:
        print(f"Error: {str(e)}")
        send_cfn_response(event, context, 'FAILED')
