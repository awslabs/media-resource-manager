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
    """Safely open URLs with scheme validation to prevent file:// and other unsafe schemes."""
    if isinstance(url_or_request, urllib.request.Request):
        url_to_check = url_or_request.full_url
    else:
        url_to_check = url_or_request
    parsed = urllib.parse.urlparse(url_to_check)
    if parsed.scheme not in ['https']:
        raise ValueError(f"Unsafe URL scheme: {parsed.scheme}")
    return urllib.request.urlopen(url_or_request, *args, **kwargs)  # nosec B310 # nosemgrep: dynamic-urllib-use-detected

def invoke_regional_lambda(region, event, context):
    """Invoke the regional DCV readiness check Lambda and return its response.
    
    This is used when a workstation is in a satellite region and we need to
    route the request to the Lambda in that region (which has VPC access to
    the regional Session Manager).
    """
    acronym = os.environ.get('ACRONYM', 'tfc').lower()
    regional_function_name = f'arn:aws:lambda:{region}:{context.invoked_function_arn.split(":")[4]}:function:{acronym}-regional-dcv-readiness-check-windows'
    
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

def get_dcv_endpoints(region=None):
    """Get DCV Session Manager and Connection Gateway endpoints.
    For satellite regions, look up endpoints from regional hub config and credentials from regional SSM.
    For primary region, use SSM parameters."""
    pascal_case_name = os.environ.get('PASCAL_CASE_NAME', 'MediaResourceManager')
    
    # Check if this is a satellite region
    if region and region != os.environ.get('AWS_REGION'):
        # Look up regional hub configuration from DynamoDB
        dynamodb = boto3.resource('dynamodb')
        table = dynamodb.Table(os.environ.get('REGIONAL_HUBS_TABLE_NAME', 'regional-hubs'))
        try:
            response = table.get_item(Key={'region': region})
            if 'Item' in response:
                hub = response['Item']
                session_manager_dns = hub.get('sessionManagerEndpoint')
                connection_gateway_endpoint = hub.get('connectionGatewayEndpoint')
                
                # Get credentials from SSM in the satellite region
                regional_ssm = boto3.client('ssm', region_name=region)
                client_id = regional_ssm.get_parameter(Name=f'/{pascal_case_name}/DCV/SessionManager/ClientId')['Parameter']['Value']
                client_password = regional_ssm.get_parameter(Name=f'/{pascal_case_name}/DCV/SessionManager/ClientPassword', WithDecryption=True)['Parameter']['Value']
                
                return {
                    'session_manager_dns': session_manager_dns,
                    'connection_gateway_endpoint': connection_gateway_endpoint,
                    'client_id': client_id,
                    'client_password': client_password
                }
        except Exception as e:
            print(f"Error looking up regional hub: {e}")
            return None
    
    # Primary region - use SSM parameters
    ssm = boto3.client('ssm')
    session_manager_dns = ssm.get_parameter(Name=f'/{pascal_case_name}/DCV/SessionManager/Endpoint')['Parameter']['Value']
    client_id = ssm.get_parameter(Name=f'/{pascal_case_name}/DCV/SessionManager/ClientId')['Parameter']['Value']
    client_password = ssm.get_parameter(Name=f'/{pascal_case_name}/DCV/SessionManager/ClientPassword', WithDecryption=True)['Parameter']['Value']
    connection_gateway_endpoint = ssm.get_parameter(Name=f'/{pascal_case_name}/DCV/ConnectionGateway/Endpoint')['Parameter']['Value']
    
    return {
        'session_manager_dns': session_manager_dns,
        'connection_gateway_endpoint': connection_gateway_endpoint,
        'client_id': client_id,
        'client_password': client_password
    }

def lambda_handler(event, context):
    print(f'Checking DCV readiness: {json.dumps(event, indent=2)}')
    
    # Get pascal case name from environment variable
    pascal_case_name = os.environ.get('PASCAL_CASE_NAME', 'MediaResourceManager')
    
    instance_id = event.get('instanceId')
    region = event.get('region')
    current_region = os.environ.get('AWS_REGION')
    
    # Route to regional Lambda if workstation is in a different region
    # Skip if this is already a regional invocation to prevent infinite recursion
    if region and region != current_region and not event.get('_isRegionalInvocation'):
        print(f"Workstation {instance_id} is in region {region}, routing to regional Lambda...")
        try:
            return invoke_regional_lambda(region, event, context)
        except Exception as e:
            print(f"Error invoking regional Lambda: {e}")
            # Return failure if regional invocation fails
            return {
                **event,
                'dcvReady': False,
                'error': f'Failed to invoke regional Lambda: {str(e)}'
            }
    
    try:
        # Get DCV endpoints (handles both primary and satellite regions)
        endpoints = get_dcv_endpoints(region)
        session_manager_dns = endpoints['session_manager_dns']
        client_id = endpoints['client_id']
        client_password = endpoints['client_password']
        
        if not session_manager_dns:
            print(f"No DCV Session Manager endpoint found for region {region}")
            return {**event, 'dcvReady': False}
        
        print(f'Got parameters - private_dns: {session_manager_dns}, client_id: {client_id[:8]}...')
        
        # Create SSL context that ignores certificate verification
        ssl_context = ssl.create_default_context()
        ssl_context.check_hostname = False
        ssl_context.verify_mode = ssl.CERT_NONE
        
        # Get OAuth2 token
        print("Getting OAuth2 token...")
        token_url = f"https://{session_manager_dns}:8443/oauth2/token?grant_type=client_credentials"
        
        credentials = f"{client_id}:{client_password}"
        encoded_credentials = base64.b64encode(credentials.encode()).decode()
        
        token_request = urllib.request.Request(
            token_url,
            method='POST',
            headers={'Authorization': f'Basic {encoded_credentials}'}
        )
        
        with safe_urlopen(token_request, context=ssl_context, timeout=10) as response:
            token_data = json.loads(response.read().decode())
            access_token = token_data['access_token']
            print("Successfully obtained OAuth2 token")
        
        # Check if server is registered using the same API as working function
        print("Step 1: Getting server list...")
        base_url = f"https://{session_manager_dns}:8443"
        
        describe_request = urllib.request.Request(
            f"{base_url}/describeServers",
            data=json.dumps({}).encode(),
            headers={
                'Authorization': f'Bearer {access_token}',
                'Content-Type': 'application/json'
            },
            method='POST'
        )
        
        with safe_urlopen(describe_request, context=ssl_context, timeout=10) as response:
            servers_data = json.loads(response.read().decode())
            print(f"Found {len(servers_data.get('Servers', []))} servers")
        
        # Find server by EC2 instance ID
        dcv_server_id = None
        server_state = None
        availability = None
        
        for server in servers_data.get('Servers', []):
            if (server.get('Host', {}).get('Aws', {}).get('EC2InstanceId') == instance_id or
                server.get('DefaultDnsName') == instance_id or
                server.get('Ip') == instance_id):
                dcv_server_id = server.get('Id')
                server_state = server.get('State')
                availability = server.get('Availability')
                print(f"Found matching server: {dcv_server_id}, State: {server_state}, Availability: {availability}")
                break
        
        if not dcv_server_id:
            print(f"DCV server not found for {instance_id}")
            return {
                **event,
                'dcvReady': False
            }
        
        # Server is ready if it's registered with the broker and has a server ID.
        # Note: Availability=UNAVAILABLE is expected for servers that already have
        # their console session running (SERVER_FULL), since max-concurrent-sessions=1.
        # The Availability field indicates readiness for NEW session placement, not
        # whether the server is functional. A registered server with a console session
        # is exactly what we want.
        is_ready = dcv_server_id is not None
        
        if not is_ready:
            print(f"DCV server found but not ready - State: {server_state}, Availability: {availability}")
            return {
                **event,
                'dcvReady': False
            }
        
        print(f"DCV readiness check completed for {instance_id}")
        
        return {
            **event,
            'dcvReady': True,
            'dcvServerId': dcv_server_id,
            'needsCleanup': False
        }
        
    except Exception as error:
        print(f"DCV readiness check failed for {instance_id}: {error}")
        return {
            **event,
            'dcvReady': False,
            'needsCleanup': False
        }