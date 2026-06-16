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


def get_workstation_region(instance_id):
    """Look up the region for a workstation from DynamoDB."""
    if not instance_id or not instance_id.startswith('i-'):
        return None
    
    try:
        dynamodb = boto3.resource('dynamodb')
        table = dynamodb.Table(os.environ.get('WORKSTATION_TABLE_NAME', 'workstation-instances'))
        response = table.get_item(Key={'instanceId': instance_id})
        
        if 'Item' in response:
            return response['Item'].get('region')
    except Exception as e:
        print(f"Error looking up workstation region: {e}")
    
    return None


def invoke_regional_lambda(region, event, context):
    """Invoke the regional DCV session cleanup Lambda and return its response.
    
    This is used when a workstation is in a satellite region and we need to
    route the request to the Lambda in that region (which has VPC access to
    the regional Session Manager).
    """
    acronym = os.environ.get('ACRONYM', 'tfc').lower()
    account_id = context.invoked_function_arn.split(":")[4]
    regional_function_name = f'arn:aws:lambda:{region}:{account_id}:function:{acronym}-regional-dcv-session-cleanup'
    
    print(f"Routing request to regional Lambda: {regional_function_name}")
    
    lambda_client = boto3.client('lambda', region_name=region)
    
    # Add a flag to prevent infinite recursion
    event_copy = {**event, '_isRegionalInvocation': True}
    
    response = lambda_client.invoke(
        FunctionName=regional_function_name,
        InvocationType='RequestResponse',
        Payload=json.dumps(event_copy)
    )
    
    # Parse the response from the regional Lambda
    response_payload = json.loads(response['Payload'].read().decode())
    print(f"Regional Lambda response: {json.dumps(response_payload)}")
    
    return response_payload


def lambda_handler(event, context):
    """
    Clean up DCV sessions when instances are stopped or terminated.
    Triggered by EventBridge on EC2 state changes or by Step Functions.
    """
    print(f'DCV session cleanup event: {json.dumps(event, indent=2)}')
    
    # Extract instance ID and state from EventBridge event
    instance_id = None
    instance_state = None
    
    if 'detail' in event and 'instance-id' in event['detail']:
        instance_id = event['detail']['instance-id']
        instance_state = event['detail'].get('state', '')
        
        print(f"Instance {instance_id} state changed to: {instance_state}")
        
        # Only process stopped and terminated instances
        if instance_state not in ['stopped', 'terminated']:
            print(f"Ignoring state change to {instance_state}")
            return {'success': True, 'message': f'Ignored state {instance_state}'}
    else:
        print("No valid EventBridge event found")
        return {'success': False, 'error': 'Invalid event format'}
    
    # Check if we need to route to a regional Lambda
    # Skip if this is already a regional invocation to prevent infinite recursion
    current_region = os.environ.get('AWS_REGION')
    if not event.get('_isRegionalInvocation'):
        workstation_region = get_workstation_region(instance_id)
        if workstation_region and workstation_region != current_region:
            print(f"Workstation {instance_id} is in region {workstation_region}, routing to regional Lambda...")
            try:
                return invoke_regional_lambda(workstation_region, event, context)
            except Exception as e:
                print(f"Error invoking regional Lambda: {e}")
                # Return failure if regional invocation fails
                return {
                    'success': False,
                    'error': f'Failed to invoke regional Lambda: {str(e)}'
                }
    
    try:
        # Get SSM parameters for DCV Session Manager
        ssm = boto3.client('ssm')
        
        try:
            # Get pascal case name from environment variable
            pascal_case_name = os.environ.get('PASCAL_CASE_NAME', 'MediaResourceManager')
            
            session_manager_dns = ssm.get_parameter(Name=f'/{pascal_case_name}/DCV/SessionManager/Endpoint')['Parameter']['Value']
            client_id = ssm.get_parameter(Name=f'/{pascal_case_name}/DCV/SessionManager/ClientId')['Parameter']['Value']
            client_password = ssm.get_parameter(Name=f'/{pascal_case_name}/DCV/SessionManager/ClientPassword', WithDecryption=True)['Parameter']['Value']
            
            print(f'Got Session Manager parameters - DNS: {session_manager_dns}')
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
        
        # Get all sessions to find ones on this instance
        print(f"Looking for sessions on instance {instance_id}...")
        try:
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
                print(f"Found {len(sessions)} total sessions")
        except Exception as e:
            print(f"Error getting sessions: {e}")
            return {'success': False, 'error': f'Failed to get sessions: {str(e)}'}
        
        # Find sessions on this instance by matching server IP
        # First get the instance's private IP
        ec2 = boto3.client('ec2')
        try:
            instance_response = ec2.describe_instances(InstanceIds=[instance_id])
            instance_ip = instance_response['Reservations'][0]['Instances'][0]['PrivateIpAddress']
            print(f"Instance {instance_id} has private IP: {instance_ip}")
        except Exception as e:
            print(f"Failed to get instance IP: {e}")
            return {'success': False, 'error': f'Failed to get instance IP: {str(e)}'}
        
        sessions_to_delete = []
        for session in sessions:
            # Match by server IP since Host.Aws.EC2InstanceId doesn't exist in the session data
            server_ip = session.get('Server', {}).get('Ip')
            if server_ip == instance_ip:
                sessions_to_delete.append({
                    'id': session.get('Id'),
                    'name': session.get('Name'),
                    'state': session.get('State'),
                    'owner': session.get('Owner')
                })
                print(f"Found session to delete: {session.get('Id')} ({session.get('Name')})")
        
        if not sessions_to_delete:
            print(f"No sessions found on instance {instance_id}")
            return {'success': True, 'message': f'No sessions to clean up on {instance_id}'}
        
        # Delete sessions using the correct API endpoint with Force parameter
        if sessions_to_delete:
            print(f"Deleting {len(sessions_to_delete)} sessions...")
            
            # Prepare delete request data with Force=true for UNKNOWN state sessions
            delete_data = []
            for session_info in sessions_to_delete:
                delete_data.append({
                    'SessionId': session_info['id'],
                    'Owner': session_info['owner'],
                    'Force': True  # Force deletion even for UNKNOWN state sessions
                })
            
            try:
                delete_request = urllib.request.Request(
                    f"{base_url}/deleteSessions",
                    data=json.dumps(delete_data).encode(),
                    headers={
                        'Authorization': f'Bearer {access_token}',
                        'Content-Type': 'application/json'
                    }
                )
                
                with safe_urlopen(delete_request, context=ssl_context, timeout=10) as response:  # nosec B310 - URL from SSM parameter
                    delete_response = json.loads(response.read().decode())
                    
                    successful = delete_response.get('SuccessfulList', [])
                    unsuccessful = delete_response.get('UnsuccessfulList', [])
                    
                    deleted_count = len(successful)
                    
                    if successful:
                        print(f"Successfully deleted {deleted_count} sessions:")
                        for session in successful:
                            print(f"  - {session.get('Id')} ({session.get('Name')})")
                    
                    if unsuccessful:
                        print(f"Failed to delete {len(unsuccessful)} sessions:")
                        for session in unsuccessful:
                            print(f"  - {session.get('Id')}: {session.get('ErrorMessage')}")
                    
            except urllib.error.HTTPError as e:
                error_body = e.read().decode() if e.fp else str(e)
                print(f"HTTP error deleting sessions: {e.code} - {error_body}")
                deleted_count = 0
            except Exception as e:
                print(f"Error deleting sessions: {e}")
                deleted_count = 0
        else:
            deleted_count = 0
        
        # Note: We no longer update DynamoDB here since sessionsCleanedUp/sessionCleanupAt
        # are not used by the frontend or any other code. This also avoids cross-region
        # DynamoDB permission issues for satellite region workstations.
        
        return {
            'success': True,
            'instanceId': instance_id,
            'instanceState': instance_state,
            'sessionsFound': len(sessions_to_delete),
            'sessionsDeleted': deleted_count,
            'message': f'Cleaned up {deleted_count} sessions on {instance_state} instance {instance_id}'
        }
        
    except Exception as error:
        print(f"DCV session cleanup failed for instance {instance_id}: {error}")
        return {'success': False, 'error': str(error)}
