# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

import json
import os
import boto3
import urllib.request
import urllib.parse
import ssl
import base64

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

def lambda_handler(event, context):
    try:
        session_id = event.get('testSessionId')
        if not session_id:
            return {**event, 'sessionDeleted': True}
        
        print(f"Verifying session {session_id} is deleted")
        
        # Get pascal case name from environment variable
        pascal_case_name = os.environ.get('PASCAL_CASE_NAME', 'MediaResourceManager')
        
        # Get SSM parameters
        ssm = boto3.client('ssm')
        client_id = ssm.get_parameter(Name=f'/{pascal_case_name}/DCV/SessionManager/ClientId')['Parameter']['Value']
        client_password = ssm.get_parameter(Name=f'/{pascal_case_name}/DCV/SessionManager/ClientPassword', WithDecryption=True)['Parameter']['Value']
        private_dns = ssm.get_parameter(Name=f'/{pascal_case_name}/DCV/SessionManager/Endpoint')['Parameter']['Value']
        
        # Get OAuth token using Basic Auth
        ssl_context = ssl.create_default_context()
        ssl_context.check_hostname = False
        ssl_context.verify_mode = ssl.CERT_NONE
        
        base_url = f"https://{private_dns}:8443"
        
        token_url = f"{base_url}/oauth2/token?grant_type=client_credentials"
        credentials = f"{client_id}:{client_password}"
        encoded_credentials = base64.b64encode(credentials.encode()).decode()
        
        token_request = urllib.request.Request(
            token_url,
            method='POST',
            headers={'Authorization': f'Basic {encoded_credentials}'}
        )
        
        with safe_urlopen(token_request, context=ssl_context, timeout=10) as response:
            token_response = json.loads(response.read().decode())
            access_token = token_response['access_token']
        
        # Check if session still exists - get all sessions
        sessions_request = urllib.request.Request(
            f"{base_url}/describeSessions",
            data=json.dumps({}).encode(),
            headers={
                'Authorization': f'Bearer {access_token}',
                'Content-Type': 'application/json'
            },
            method='POST'
        )
        
        with safe_urlopen(sessions_request, context=ssl_context, timeout=10) as response:
            sessions_response = json.loads(response.read().decode())
        
        # Check if our session still exists and is not deleted
        for session in sessions_response.get('Sessions', []):
            if session.get('Id') == session_id:
                session_state = session.get('State', '')
                print(f"Session {session_id} found with state: {session_state}")
                
                if session_state == 'DELETED':
                    print(f"Session {session_id} is fully deleted - success!")
                    return {**event, 'sessionDeleted': True}
                elif session_state == 'DELETING':
                    print(f"Session {session_id} still deleting - waiting...")
                    return {**event, 'sessionDeleted': False}
                else:
                    print(f"Session {session_id} in unexpected state: {session_state} - may need manual cleanup")
                    return {**event, 'sessionDeleted': False}
        
        print(f"Session {session_id} not found in list - successfully deleted")
        return {**event, 'sessionDeleted': True}
        
    except Exception as e:
        print(f"Error verifying session deletion: {str(e)}")
        # If we can't verify, assume it's deleted to avoid infinite loops
        return {**event, 'sessionDeleted': True}