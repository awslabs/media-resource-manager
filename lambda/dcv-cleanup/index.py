# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

import json
import os
import boto3
import urllib.request
import urllib.parse
import urllib.error
import ssl
import base64


def safe_urlopen(url_or_request, *args, **kwargs):
    """
    Safely open URLs with scheme validation for DCV session management.
    URLs are constructed from SSM parameters (trusted infrastructure).
    """
    # Handle both URL strings and Request objects
    if isinstance(url_or_request, urllib.request.Request):
        url_to_check = url_or_request.full_url
    else:
        url_to_check = url_or_request

    parsed = urllib.parse.urlparse(url_to_check)
    if parsed.scheme not in ['https']:
        raise ValueError(f"Unsafe URL scheme: {parsed.scheme}")
    return urllib.request.urlopen(url_or_request, *args, **kwargs)  # nosec B310 # nosemgrep: dynamic-urllib-use-detected


def lambda_handler(event, context):
    """
    Clean up DCV servers when EC2 instances are terminated.
    Triggered by EventBridge rule on EC2 state change to 'terminated'.
    """
    print(f'DCV cleanup event: {json.dumps(event, indent=2)}')
    
    # Extract instance ID from EventBridge event
    instance_id = None
    if 'detail' in event and 'instance-id' in event['detail']:
        instance_id = event['detail']['instance-id']
        instance_state = event['detail'].get('state', '')
        
        print(f"Instance {instance_id} state changed to: {instance_state}")
        
        # Only process terminated instances
        if instance_state != 'terminated':
            print(f"Ignoring state change to {instance_state}")
            return {'success': True, 'message': f'Ignored state {instance_state}'}
    else:
        # Direct invocation with instanceId parameter
        instance_id = event.get('instanceId')
        if not instance_id:
            print("No instanceId found in event")
            return {'success': False, 'error': 'instanceId required'}
    
    try:
        # Get SSM parameters
        ssm = boto3.client('ssm')
        
        try:
            # Get pascal case name from environment variable
            pascal_case_name = os.environ.get('PASCAL_CASE_NAME', 'MediaResourceManager')
            
            session_manager_dns = ssm.get_parameter(Name=f'/{pascal_case_name}/DCV/SessionManager/Endpoint')['Parameter']['Value']
            client_id = ssm.get_parameter(Name=f'/{pascal_case_name}/DCV/SessionManager/ClientId')['Parameter']['Value']
            client_password = ssm.get_parameter(Name=f'/{pascal_case_name}/DCV/SessionManager/ClientPassword', WithDecryption=True)['Parameter']['Value']
            
            print(f'Got parameters - private_dns: {session_manager_dns}, client_id: {client_id[:8]}...')
        except Exception as e:
            print(f"Failed to get SSM parameters: {e}")
            return {'success': False, 'error': f'SSM parameter error: {str(e)}'}
        
        # Create SSL context that ignores certificate verification
        ssl_context = ssl.create_default_context()
        ssl_context.check_hostname = False
        ssl_context.verify_mode = ssl.CERT_NONE
        
        # Get OAuth2 token
        print("Getting OAuth2 token...")
        try:
            token_url = f"https://{session_manager_dns}:8443/oauth2/token?grant_type=client_credentials"
            
            credentials = f"{client_id}:{client_password}"
            encoded_credentials = base64.b64encode(credentials.encode()).decode()
            
            token_request = urllib.request.Request(
                token_url,
                method='POST',
                headers={'Authorization': f'Basic {encoded_credentials}'}
            )
            
            with safe_urlopen(token_request, context=ssl_context, timeout=10) as response:  # nosec B310 - URL from SSM parameter
                token_data = json.loads(response.read().decode())
                access_token = token_data['access_token']
                print("Successfully obtained OAuth2 token")
        except Exception as e:
            print(f"OAuth2 token error: {e}")
            return {'success': False, 'error': f'OAuth2 error: {str(e)}'}
        
        base_url = f"https://{session_manager_dns}:8443"
        
        # Get all servers
        print("Getting server list...")
        try:
            describe_request = urllib.request.Request(
                f"{base_url}/describeServers",
                data=json.dumps({}).encode(),
                headers={
                    'Authorization': f'Bearer {access_token}',
                    'Content-Type': 'application/json'
                },
                method='POST'
            )
            
            with safe_urlopen(describe_request, context=ssl_context, timeout=10) as response:  # nosec B310 - URL from SSM parameter
                servers_data = json.loads(response.read().decode())
                servers = servers_data.get('Servers', [])
                print(f"Found {len(servers)} total servers in DCV Session Manager")
        except Exception as e:
            print(f"Error getting server list: {e}")
            return {'success': False, 'error': f'Failed to get servers: {str(e)}'}
        
        # Find server for this instance
        server_to_remove = None
        for server in servers:
            server_instance_id = server.get('Host', {}).get('Aws', {}).get('EC2InstanceId')
            if server_instance_id == instance_id:
                server_to_remove = {
                    'id': server.get('Id'),
                    'instanceId': server_instance_id,
                    'availability': server.get('Availability'),
                    'hostname': server.get('DefaultDnsName', 'unknown')
                }
                print(f"Found server to remove: {server.get('Id')} for instance {instance_id}")
                break
        
        if not server_to_remove:
            print(f"No DCV server found for terminated instance {instance_id}")
            return {'success': True, 'message': f'No server found for instance {instance_id}'}
        
        server_id = server_to_remove['id']
        
        # First, clean up any sessions on this server
        sessions_cleaned = 0
        try:
            print(f"Checking for sessions on server {server_id}...")
            sessions_request = urllib.request.Request(
                f"{base_url}/describeSessions",
                data=json.dumps({}).encode(),
                headers={
                    'Authorization': f'Bearer {access_token}',
                    'Content-Type': 'application/json'
                },
                method='POST'
            )
            
            with safe_urlopen(sessions_request, context=ssl_context, timeout=10) as response:  # nosec B310 - URL from SSM parameter
                sessions_data = json.loads(response.read().decode())
                sessions = sessions_data.get('Sessions', [])
                
                for session in sessions:
                    if session.get('Server', {}).get('Id') == server_id:
                        session_id = session.get('Id')
                        print(f"Deleting session {session_id} on server {server_id}")
                        
                        try:
                            delete_session_request = urllib.request.Request(
                                f"{base_url}/sessions/{session_id}",
                                headers={
                                    'Authorization': f'Bearer {access_token}',
                                    'Content-Type': 'application/json'
                                },
                                method='DELETE'
                            )
                            
                            with safe_urlopen(delete_session_request, context=ssl_context, timeout=10) as response:  # nosec B310 - URL from SSM parameter
                                print(f"Session {session_id} deleted successfully")
                                sessions_cleaned += 1
                        except Exception as e:
                            print(f"Failed to delete session {session_id}: {e}")
                            
        except Exception as e:
            print(f"Error cleaning up sessions for server {server_id}: {e}")
        
        # Remove the server
        try:
            print(f"Removing server {server_id} from DCV Session Manager...")
            
            remove_request = urllib.request.Request(
                f"{base_url}/servers/{server_id}",
                headers={
                    'Authorization': f'Bearer {access_token}',
                    'Content-Type': 'application/json'
                },
                method='DELETE'
            )
            
            with safe_urlopen(remove_request, context=ssl_context, timeout=10) as response:  # nosec B310 - URL from SSM parameter
                print(f"Server {server_id} removed successfully from DCV Session Manager")
                
                # Also clean up DynamoDB record if it exists
                try:
                    dynamodb = boto3.resource('dynamodb')
                    table = dynamodb.Table(os.environ.get('WORKSTATION_TABLE_NAME', 'workstation-instances'))
                    
                    # Update the record to mark DCV as cleaned up
                    table.update_item(
                        Key={'instanceId': instance_id},
                        UpdateExpression='SET dcvStatus = :status, dcvCleanedAt = :cleanedAt',
                        ExpressionAttributeValues={
                            ':status': 'cleaned',
                            ':cleanedAt': context.aws_request_id
                        },
                        ConditionExpression='attribute_exists(instanceId)'
                    )
                    print(f"Updated DynamoDB record for instance {instance_id}")
                except Exception as db_error:
                    print(f"Failed to update DynamoDB: {db_error}")
                
                return {
                    'success': True,
                    'instanceId': instance_id,
                    'serverId': server_id,
                    'sessionsCleanedUp': sessions_cleaned,
                    'message': f'Successfully cleaned up DCV server {server_id} for terminated instance {instance_id}'
                }
                
        except urllib.error.HTTPError as e:
            error_body = e.read().decode() if e.fp else str(e)
            print(f"HTTP error removing server {server_id}: {e.code} - {error_body}")
            return {'success': False, 'error': f'HTTP {e.code}: {error_body}'}
        except Exception as e:
            print(f"Error removing server {server_id}: {e}")
            return {'success': False, 'error': f'Failed to remove server: {str(e)}'}
        
    except Exception as error:
        print(f"DCV cleanup failed for instance {instance_id}: {error}")
        return {'success': False, 'error': str(error)}
