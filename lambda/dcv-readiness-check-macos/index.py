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

def invoke_regional_lambda(region, event, context):
    """Invoke the regional DCV readiness check Lambda and return its response.
    
    This is used when a workstation is in a satellite region and we need to
    route the request to the Lambda in that region (which has VPC access to
    the regional Session Manager).
    """
    acronym = os.environ.get('ACRONYM', 'tfc').lower()
    regional_function_name = f'arn:aws:lambda:{region}:{context.invoked_function_arn.split(":")[4]}:function:{acronym}-regional-dcv-readiness-check-macos'
    
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
    pascal_case_name = os.environ.get('PASCAL_CASE_NAME')
    
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
    pascal_case_name = os.environ.get('PASCAL_CASE_NAME')
    instance_id = event.get('instanceId')
    region = event.get('region')
    current_region = os.environ.get('AWS_REGION')
    
    print(f"Checking DCV readiness for macOS instance: {instance_id} (region: {region or 'primary'})")
    
    # Route to regional Lambda if workstation is in a different region
    # Skip if this is already a regional invocation to prevent infinite recursion
    if region and region != current_region and not event.get('_isRegionalInvocation'):
        print(f"Workstation {instance_id} is in region {region}, routing to regional Lambda...")
        try:
            result = invoke_regional_lambda(region, event, context)
            # Strip the regional invocation flag so subsequent state machine
            # iterations still route to the regional Lambda
            result.pop('_isRegionalInvocation', None)
            return result
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
        if not endpoints:
            print(f"Could not retrieve DCV endpoints for region {region}")
            return {**event, 'dcvReady': False}
        session_manager_dns = endpoints['session_manager_dns']
        client_id = endpoints['client_id']
        client_password = endpoints['client_password']
        
        if not session_manager_dns:
            print(f"No DCV Session Manager endpoint found for region {region}")
            return {**event, 'dcvReady': False}
        
        ssl_context = ssl.create_default_context()
        ssl_context.check_hostname = False
        ssl_context.verify_mode = ssl.CERT_NONE
        
        # Get OAuth2 token
        token_url = f"https://{session_manager_dns}:8443/oauth2/token?grant_type=client_credentials"
        credentials = f"{client_id}:{client_password}"
        encoded_credentials = base64.b64encode(credentials.encode()).decode()
        
        token_request = urllib.request.Request(token_url, method='POST', headers={'Authorization': f'Basic {encoded_credentials}'})
        with safe_urlopen(token_request, context=ssl_context, timeout=10) as response:
            access_token = json.loads(response.read().decode())['access_token']
        
        # Check if server is registered and AVAILABLE
        describe_request = urllib.request.Request(
            f"https://{session_manager_dns}:8443/describeServers",
            data=json.dumps({}).encode(),
            headers={'Authorization': f'Bearer {access_token}', 'Content-Type': 'application/json'},
            method='POST'
        )
        
        with safe_urlopen(describe_request, context=ssl_context, timeout=10) as response:
            servers_data = json.loads(response.read().decode())
        
        for server in servers_data.get('Servers', []):
            ec2_id = server.get('Host', {}).get('Aws', {}).get('EC2InstanceId')
            if ec2_id == instance_id:
                server_id = server.get('Id')
                server_state = server.get('State')
                availability = server.get('Availability')
                print(f"Found server {server_id} for instance {instance_id}, State: {server_state}, Availability: {availability}")
                
                # Server is ready if State=READY or Availability=AVAILABLE
                # The API may return State as None but Availability as AVAILABLE when server is ready
                is_ready = (server_state == 'READY') or (availability == 'AVAILABLE')
                
                if is_ready:
                    print(f"DCV ready! Server ID: {server_id}")
                    return {**event, 'dcvReady': True, 'dcvServerId': server_id}
                else:
                    print(f"Server found but not ready yet - State: {server_state}, Availability: {availability}")
                    return {**event, 'dcvReady': False}
        
        print(f"Instance {instance_id} not found in servers list")
        return {**event, 'dcvReady': False}
    except Exception as e:
        print(f"DCV check error: {e}")
        import traceback
        traceback.print_exc()
        return {**event, 'dcvReady': False}
