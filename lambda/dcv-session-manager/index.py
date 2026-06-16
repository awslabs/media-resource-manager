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

def get_workstation_region(server_id):
    """Look up the region for a workstation from DynamoDB.
    
    Returns the region string or None if not found.
    """
    if not server_id or not server_id.startswith('i-'):
        return None
    
    try:
        table_name = os.environ.get('WORKSTATION_TABLE_NAME', 'workstation-instances')
        response = _dynamodb_table(table_name).get_item(Key={'instanceId': server_id})
        
        if 'Item' in response:
            return response['Item'].get('region')
    except Exception as e:
        print(f"Error looking up workstation region: {e}")
    
    return None

# Cache DynamoDB table references to avoid creating new clients on every invocation
_dynamodb_tables = {}
def _dynamodb_table(table_name):
    if table_name not in _dynamodb_tables:
        _dynamodb_tables[table_name] = boto3.resource('dynamodb').Table(table_name)
    return _dynamodb_tables[table_name]

def invoke_regional_lambda(region, event):
    """Invoke the regional DCV session manager Lambda and return its response.
    
    This is used when a workstation is in a satellite region and we need to
    route the request to the Lambda in that region (which has VPC access to
    the regional Session Manager).
    """
    acronym = os.environ.get('ACRONYM', 'tfc').lower()
    regional_function_name = f'arn:aws:lambda:{region}:{os.environ.get("AWS_ACCOUNT_ID")}:function:{acronym}-regional-dcv-session-manager'
    
    print(f"Routing request to regional Lambda: {regional_function_name}")
    
    lambda_client = boto3.client('lambda', region_name=region)
    
    response = lambda_client.invoke(
        FunctionName=regional_function_name,
        InvocationType='RequestResponse',
        Payload=json.dumps(event)
    )
    
    # Parse the response from the regional Lambda
    response_payload = json.loads(response['Payload'].read().decode())
    print(f"Regional Lambda response status: {response_payload.get('statusCode')}")
    
    return response_payload

def get_default_session_owner(server_id):
    """Get the default session owner based on workstation platform and distro.
    
    For Rocky/RHEL/CentOS Linux workstations, use 'rocky' as the default user.
    For Ubuntu Linux workstations, use 'ubuntu' as the default user.
    For macOS workstations, use 'ec2-user' as the default user.
    For Windows workstations, use 'Administrator' as the default user.
    
    Returns tuple of (owner, region) where region is the workstation's region.
    """
    region = None
    try:
        # Check if server_id looks like an EC2 instance ID
        if server_id and server_id.startswith('i-'):
            dynamodb = boto3.resource('dynamodb')
            table = dynamodb.Table(os.environ.get('WORKSTATION_TABLE_NAME', 'workstation-instances'))
            response = table.get_item(Key={'instanceId': server_id})
            
            if 'Item' in response:
                platform = response['Item'].get('platform', 'Windows')
                workstation_name = response['Item'].get('workstationName', '').lower()
                linux_distro = response['Item'].get('linuxDistro', '').lower()
                ami_id = response['Item'].get('amiId', '')
                region = response['Item'].get('region')  # Get workstation region
                print(f"Workstation platform: {platform}, name: {workstation_name}, linuxDistro: {linux_distro}, region: {region}")
                
                if platform == 'macOS':
                    print("Detected macOS - using 'ec2-user' as session owner")
                    return 'ec2-user', region
                elif platform == 'Linux':
                    # Check linuxDistro field first (most reliable)
                    if linux_distro:
                        if linux_distro in ['rocky', 'rhel', 'centos']:
                            print(f"Detected {linux_distro} from linuxDistro field - using 'rocky' as session owner")
                            return 'rocky', region
                        elif linux_distro == 'ubuntu':
                            print("Detected ubuntu from linuxDistro field - using 'ubuntu' as session owner")
                            return 'ubuntu', region
                    
                    # Check workstation name for distro hints
                    if 'rocky' in workstation_name or 'rhel' in workstation_name or 'centos' in workstation_name:
                        print("Detected Rocky/RHEL/CentOS from workstation name - using 'rocky' as session owner")
                        return 'rocky', region
                    
                    # Check AMI name/description as fallback
                    if ami_id:
                        try:
                            ec2 = boto3.client('ec2')
                            ami_response = ec2.describe_images(ImageIds=[ami_id])
                            if ami_response.get('Images'):
                                ami_name = ami_response['Images'][0].get('Name', '').lower()
                                ami_desc = ami_response['Images'][0].get('Description', '').lower()
                                print(f"AMI name: {ami_name}, description: {ami_desc}")
                                
                                if 'rocky' in ami_name or 'rocky' in ami_desc or 'rhel' in ami_name or 'centos' in ami_name:
                                    print("Detected Rocky/RHEL/CentOS from AMI - using 'rocky' as session owner")
                                    return 'rocky', region
                        except Exception as e:
                            print(f"Error checking AMI: {e}")
                    
                    # Default to ubuntu for Linux if we can't determine distro
                    print("Could not determine Linux distro - defaulting to 'ubuntu' as session owner")
                    return 'ubuntu', region
        
        return 'Administrator', region
    except Exception as e:
        print(f"Error getting workstation platform: {e}")
        return 'Administrator', None

def get_regional_dcv_endpoints(region):
    """Get DCV endpoints for a satellite region from regional hub config and regional SSM."""
    if not region or region == os.environ.get('AWS_REGION'):
        return None  # Use primary region endpoints
    
    pascal_case_name = os.environ.get('PASCAL_CASE_NAME', 'MediaResourceManager')
    
    try:
        dynamodb = boto3.resource('dynamodb')
        table = dynamodb.Table(os.environ.get('REGIONAL_HUBS_TABLE_NAME', 'regional-hubs'))
        response = table.get_item(Key={'region': region})
        
        if 'Item' in response:
            hub = response['Item']
            session_manager_endpoint = hub.get('sessionManagerEndpoint')
            connection_gateway_endpoint = hub.get('connectionGatewayEndpoint')
            
            # Get credentials from SSM in the satellite region
            regional_ssm = boto3.client('ssm', region_name=region)
            client_id = regional_ssm.get_parameter(Name=f'/{pascal_case_name}/DCV/SessionManager/ClientId')['Parameter']['Value']
            client_password = regional_ssm.get_parameter(Name=f'/{pascal_case_name}/DCV/SessionManager/ClientPassword', WithDecryption=True)['Parameter']['Value']
            
            return {
                'session_manager_endpoint': session_manager_endpoint,
                'connection_gateway_endpoint': connection_gateway_endpoint,
                'client_id': client_id,
                'client_password': client_password
            }
    except Exception as e:
        print(f"Error looking up regional hub for {region}: {e}")
    
    return None

# Bandit: B310 - Allow HTTPS and DCV schemes for session management
def safe_urlopen(url_or_request, *args, **kwargs):
    """Safely open URLs with scheme validation for DCV session management"""
    # Handle both URL strings and Request objects
    if isinstance(url_or_request, urllib.request.Request):
        url_to_check = url_or_request.full_url
    else:
        url_to_check = url_or_request
    
    parsed = urllib.parse.urlparse(url_to_check)
    if parsed.scheme not in ['https', 'dcv']:
        raise ValueError(f"Unsafe URL scheme: {parsed.scheme}")
    return urllib.request.urlopen(url_or_request, *args, **kwargs)  # nosec B310 # nosemgrep: dynamic-urllib-use-detected

def lambda_handler(event, context):
    # CORS headers
    cors_headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
        'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS'
    }
    
    if event.get('httpMethod') == 'OPTIONS':
        return {
            'statusCode': 200,
            'headers': cors_headers,
            'body': ''
        }
    
    try:
        body = json.loads(event.get('body', '{}'))
        action = body.get('action')
        server_id = body.get('serverId')
        # Support both sessionName (new) and sessionId (legacy) for the display name
        session_name = body.get('sessionName') or body.get('sessionId')
        # For describe-sessions filtering by DCV session ID
        session_id = body.get('dcvSessionId')
        session_type = body.get('sessionType', 'console')
        owner = body.get('owner')
        
        current_region = os.environ.get('AWS_REGION')
        
        # Route to regional Lambda if workstation is in a different region
        # This is needed because the DCV Session Manager Lambda must be in the same
        # VPC as the Session Manager broker to communicate with it
        if server_id and action in ['create-session', 'describe-servers', 'describe-sessions']:
            workstation_region = get_workstation_region(server_id)
            if workstation_region and workstation_region != current_region:
                print(f"Workstation {server_id} is in region {workstation_region}, routing to regional Lambda...")
                try:
                    return invoke_regional_lambda(workstation_region, event)
                except Exception as e:
                    print(f"Error invoking regional Lambda: {e}")
                    return {
                        'statusCode': 500,
                        'headers': cors_headers,
                        'body': json.dumps({
                            'error': f'Failed to connect to regional DCV service: {str(e)}',
                            'errorType': 'RegionalRoutingError',
                            'region': workstation_region
                        })
                    }
        
        # Get SSM parameters
        ssm = boto3.client('ssm')
        
        try:
            print("Getting SSM parameters...")
            # Get pascal case name from environment variable
            pascal_case_name = os.environ.get('PASCAL_CASE_NAME', 'MediaResourceManager')
            param_prefix = f"/{pascal_case_name}/DCV"
            
            client_id = ssm.get_parameter(Name=f'{param_prefix}/SessionManager/ClientId')['Parameter']['Value']
            client_password = ssm.get_parameter(Name=f'{param_prefix}/SessionManager/ClientPassword', WithDecryption=True)['Parameter']['Value']
            private_dns = ssm.get_parameter(Name=f'{param_prefix}/SessionManager/Endpoint')['Parameter']['Value']
            connection_gateway_endpoint = ssm.get_parameter(Name=f'{param_prefix}/ConnectionGateway/Endpoint')['Parameter']['Value']
            print(f"Got parameters - private_dns: {private_dns}, client_id: {client_id[:8]}..., connection_gateway: {connection_gateway_endpoint}")
        except Exception as e:
            print(f"SSM Error: {e}")
            return {
                'statusCode': 500,
                'headers': cors_headers,
                'body': json.dumps({'error': f'Failed to get SSM parameters: {str(e)}'})
            }
        
        # Create SSL context that ignores certificate verification
        ssl_context = ssl.create_default_context()
        ssl_context.check_hostname = False
        ssl_context.verify_mode = ssl.CERT_NONE
        
        # Get OAuth2 token
        print("Getting OAuth2 token...")
        try:
            token_url = f"https://{private_dns}:8443/oauth2/token?grant_type=client_credentials"
            
            # Create basic auth header
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
        except Exception as e:
            print(f"OAuth2 token error: {e}")
            return {
                'statusCode': 500,
                'headers': cors_headers,
                'body': json.dumps({'error': f'Failed to get OAuth2 token: {str(e)}'})
            }
        
        base_url = f"https://{private_dns}:8443"
        
        try:
            if action == 'describe-servers':
                print("Calling describe-servers API...")
                request_data = {}
                request = urllib.request.Request(
                    f"{base_url}/describeServers",
                    data=json.dumps(request_data).encode(),
                    headers={
                        'Authorization': f'Bearer {access_token}',
                        'Content-Type': 'application/json'
                    },
                    method='POST'
                )
                
                with safe_urlopen(request, context=ssl_context, timeout=10) as response:
                    result = json.loads(response.read().decode())
                    return {
                        'statusCode': 200,
                        'headers': cors_headers,
                        'body': json.dumps(result)
                    }
                
            elif action == 'describe-sessions':
                print("Calling describe-sessions API...")
                
                # describeSessions API supports: SessionIds, Filters (tag:key, owner), NextToken
                # It does NOT support 'requirements' like describeServers does
                request_data = {}
                if session_id:
                    # Can filter by specific session IDs
                    request_data['SessionIds'] = [session_id]
                    print(f"Filtering by session ID: {session_id}")
                if owner:
                    # Can filter by owner using Filters
                    request_data['Filters'] = [{'Key': 'owner', 'Value': owner}]
                    print(f"Filtering by owner: {owner}")
                
                request = urllib.request.Request(
                    f"{base_url}/describeSessions",
                    data=json.dumps(request_data).encode(),
                    headers={
                        'Authorization': f'Bearer {access_token}',
                        'Content-Type': 'application/json'
                    },
                    method='POST'
                )
                
                with safe_urlopen(request, context=ssl_context, timeout=10) as response:
                    result = json.loads(response.read().decode())
                    return {
                        'statusCode': 200,
                        'headers': cors_headers,
                        'body': json.dumps(result)
                    }
                
            elif action == 'create-session':
                if not server_id or not session_name:
                    raise Exception('serverId and sessionName are required for create-session')
                
                print(f"Starting session creation flow for server {server_id}...")
                
                # Step 1: Describe servers to find the DCV server ID
                # Note: describeServers API only supports ServerIds, NextToken, MaxResults
                # It does NOT support 'requirements' filter, so we fetch all and filter in Python
                print(f"Step 1: Getting server list to find instance {server_id}...")
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
                    print(f"Found {len(servers_data.get('Servers', []))} total servers")
                
                # Find server by EC2 instance ID
                # There may be duplicates after agent restart, prefer AVAILABLE servers
                dcv_server_id = None
                server_available = False
                matching_servers = []
                matching_server_ids = []
                for server in servers_data.get('Servers', []):
                    if server.get('Host', {}).get('Aws', {}).get('EC2InstanceId') == server_id:
                        matching_servers.append(server)
                        matching_server_ids.append(server.get('Id'))
                
                # Sort to prefer AVAILABLE servers
                matching_servers.sort(key=lambda s: 0 if s.get('Availability') == 'AVAILABLE' else 1)
                
                if matching_servers:
                    server = matching_servers[0]
                    dcv_server_id = server.get('Id')
                    server_available = server.get('Availability') == 'AVAILABLE'
                    print(f"Found {len(matching_servers)} matching server(s), using: {dcv_server_id}, Available: {server_available}")
                    print(f"All matching server IDs: {matching_server_ids}")
                
                if not dcv_server_id:
                    raise Exception(f'No DCV server found for {server_id}')
                
                created_session_id = None
                
                # Step 2: First check for existing READY session for this server
                # Note: describeSessions API doesn't support filtering by server/instance ID
                # It only supports SessionIds, Filters (tag:key, owner), and NextToken
                # So we fetch all sessions and filter in Python
                print(f"Step 2: Checking for existing sessions...")
                describe_sessions_request = urllib.request.Request(
                    f"{base_url}/describeSessions",
                    data=json.dumps({}).encode(),
                    headers={
                        'Authorization': f'Bearer {access_token}',
                        'Content-Type': 'application/json'
                    },
                    method='POST'
                )
                
                with safe_urlopen(describe_sessions_request, context=ssl_context, timeout=10) as response:
                    sessions_response = json.loads(response.read().decode())
                    print(f"Found {len(sessions_response.get('Sessions', []))} total sessions")
                
                # Look for existing usable session on this server for the specific owner
                # ONLY accept READY sessions - UNKNOWN sessions are often stale after reboots/agent restarts
                # and don't actually exist on the DCV server anymore
                # Check ALL matching server IDs (there may be duplicates after agent restart)
                # Determine the default session owner based on platform
                default_owner, workstation_region = get_default_session_owner(server_id)
                session_owner = owner if owner else default_owner
                print(f"Using session owner: {session_owner} (default: {default_owner}, region: {workstation_region})")
                
                # Get regional connection gateway if workstation is in a satellite region
                regional_connection_gateway = None
                if workstation_region and workstation_region != os.environ.get('AWS_REGION'):
                    regional_endpoints = get_regional_dcv_endpoints(workstation_region)
                    if regional_endpoints and regional_endpoints.get('connection_gateway_endpoint'):
                        regional_connection_gateway = regional_endpoints['connection_gateway_endpoint']
                        print(f"Using regional connection gateway for {workstation_region}: {regional_connection_gateway}")
                
                # Get the server's reported session count to validate session existence
                server_session_count = 0
                for server in matching_servers:
                    console_count = server.get('ConsoleSessionCount', 0)
                    virtual_count = server.get('VirtualSessionCount', 0)
                    server_session_count = max(server_session_count, console_count + virtual_count)
                print(f"Server reports {server_session_count} active session(s)")
                
                # ONLY accept READY sessions - UNKNOWN/CREATING/CREATED sessions are unreliable
                # UNKNOWN sessions often don't exist on the actual DCV server after reboots
                usable_states = ['READY']
                print(f"Only accepting READY sessions (ignoring UNKNOWN/stale sessions)")
                
                for session in sessions_response.get('Sessions', []):
                    session_state = session.get('State', '').upper()
                    session_server_id = session.get('Server', {}).get('Id')
                    existing_session_name = session.get('Name', '')
                    
                    # Skip test sessions from readiness checks - they should be cleaned up
                    if existing_session_name.startswith('test-readiness-'):
                        print(f"Skipping test session: {session.get('Id')} ({existing_session_name})")
                        continue
                    
                    # Check if session is on ANY of the matching servers (handles duplicate server entries)
                    if (session_server_id in matching_server_ids and 
                        session_state in usable_states and
                        session.get('Owner') == session_owner):
                        # Additional validation: if server reports 0 sessions, don't trust Session Manager's session list
                        if server_session_count == 0:
                            print(f"Server reports 0 sessions but Session Manager shows session {session.get('Id')} - skipping stale session")
                            continue
                        created_session_id = session.get('Id')
                        dcv_server_id = session_server_id  # Use the server ID that has the session
                        print(f"Found existing usable session: {created_session_id} (state: {session_state}, server: {dcv_server_id})")
                        break
                
                if server_available and not created_session_id:
                    # Step 3a: Create new session (only if no existing READY session found)
                    print(f"Step 3a: Creating new session '{session_name}'...")
                    
                    # session_owner already set above based on platform
                    print(f"Creating session for user: {session_owner}")
                    
                    session_data = [{
                        'Name': session_name,
                        'Owner': session_owner,
                        'Type': session_type.upper(),
                        'Requirements': f"server:Host.Aws.Ec2InstanceId = '{server_id}'"
                    }]
                    
                    create_request = urllib.request.Request(
                        f"{base_url}/createSessions",
                        data=json.dumps(session_data).encode(),
                        headers={
                            'Authorization': f'Bearer {access_token}',
                            'Content-Type': 'application/json'
                        },
                        method='POST'
                    )
                    
                    with safe_urlopen(create_request, context=ssl_context, timeout=10) as response:
                        create_response = json.loads(response.read().decode())
                        print(f"Create session response: {create_response}")
                    
                    if not create_response.get('SuccessfulList'):
                        failure_reason = create_response.get('UnsuccessfulList', [{}])[0].get('FailureReason', 'Unknown error')
                        raise Exception(f'Session creation failed: {failure_reason}')
                    
                    created_session_id = create_response['SuccessfulList'][0]['Id']
                    print(f"New session created: {created_session_id}")
                    
                elif not created_session_id:
                    # Step 3b: Server unavailable OR no existing READY session found
                    # Try to create a new session anyway - the server might become available
                    print("Step 3b: No usable session found, attempting to create new session...")
                    
                    # If server reports as unavailable but we need a session, try creating one anyway
                    # The Session Manager might have stale availability info
                    if not server_available:
                        print(f"Server shows as unavailable, but attempting session creation anyway...")
                    
                    try:
                        session_data = [{
                            'Name': session_name,
                            'Owner': session_owner,
                            'Type': session_type.upper(),
                            'Requirements': f"server:Host.Aws.Ec2InstanceId = '{server_id}'"
                        }]
                        
                        create_request = urllib.request.Request(
                            f"{base_url}/createSessions",
                            data=json.dumps(session_data).encode(),
                            headers={
                                'Authorization': f'Bearer {access_token}',
                                'Content-Type': 'application/json'
                            },
                            method='POST'
                        )
                        
                        with safe_urlopen(create_request, context=ssl_context, timeout=10) as response:
                            create_response = json.loads(response.read().decode())
                            print(f"Create session response: {create_response}")
                        
                        if create_response.get('SuccessfulList'):
                            created_session_id = create_response['SuccessfulList'][0]['Id']
                            print(f"New session created: {created_session_id}")
                        else:
                            failure_reason = create_response.get('UnsuccessfulList', [{}])[0].get('FailureReason', 'Unknown error')
                            print(f"Session creation failed: {failure_reason}")
                            raise Exception(f'Session creation failed: {failure_reason}')
                    except Exception as create_error:
                        print(f"Failed to create session: {create_error}")
                        raise Exception(f'Unable to create DCV session. The server may still be initializing. Please wait a moment and try again. Error: {str(create_error)}')
                else:
                    print(f"Using existing READY session: {created_session_id}")
                
                # Step 4: Wait for session to be ready, then get connection data
                print("Step 4: Waiting for session to be ready...")
                import time
                
                max_attempts = 10
                attempt = 0
                connection_data = None
                session_invalid = False
                
                while attempt < max_attempts:
                    try:
                        print(f"Attempt {attempt + 1}: Getting connection data...")
                        connection_request = urllib.request.Request(
                            f"{base_url}/sessionConnectionData/{created_session_id}/{session_owner}",
                            headers={
                                'Authorization': f'Bearer {access_token}',
                                'Content-Type': 'application/json'
                            }
                        )
                        
                        with safe_urlopen(connection_request, context=ssl_context, timeout=10) as response:
                            connection_data = json.loads(response.read().decode())
                            print(f"Connection data: {connection_data}")
                            break  # Success - exit the loop
                            
                    except urllib.error.HTTPError as e:
                        error_body = e.read().decode() if e.fp else ''
                        print(f"HTTP error {e.code}: {error_body}")
                        print(f"Response headers: {dict(e.headers) if hasattr(e, 'headers') else 'None'}")
                        print(f"URL that failed: {e.url if hasattr(e, 'url') else connection_request.full_url}")
                        
                        if e.code == 400 and ("not in READY" in error_body or "neither in READY" in error_body):
                            # Session not ready yet, wait and retry
                            attempt += 1
                            if attempt < max_attempts:
                                print(f"Session not ready, waiting 3 seconds before retry {attempt + 1}/{max_attempts}...")
                                time.sleep(3)  # nosemgrep: python.lang.best-practice.sleep.arbitrary-sleep
                                continue
                        
                        # Check for invalid session errors - session might not exist on server
                        if e.code == 404 or (e.code == 400 and ("invalid" in error_body.lower() or "not found" in error_body.lower())):
                            print(f"Session {created_session_id} appears to be invalid/stale")
                            session_invalid = True
                            break
                        
                        # Other HTTP errors or max attempts reached
                        raise e
                    except Exception as e:
                        print(f"Unexpected error: {e}")
                        raise e
                
                # If session was invalid, try to create a fresh one
                if session_invalid:
                    print("Session was invalid, creating a fresh session...")
                    fresh_session_id = f"session-{session_owner}-{int(time.time())}"
                    session_data = [{
                        'Name': fresh_session_id,
                        'Owner': session_owner,
                        'Type': session_type.upper(),
                        'Requirements': f"server:Host.Aws.Ec2InstanceId = '{server_id}'"
                    }]
                    
                    create_request = urllib.request.Request(
                        f"{base_url}/createSessions",
                        data=json.dumps(session_data).encode(),
                        headers={
                            'Authorization': f'Bearer {access_token}',
                            'Content-Type': 'application/json'
                        },
                        method='POST'
                    )
                    
                    with safe_urlopen(create_request, context=ssl_context, timeout=10) as response:
                        create_response = json.loads(response.read().decode())
                        print(f"Fresh session create response: {create_response}")
                    
                    if not create_response.get('SuccessfulList'):
                        failure_reason = create_response.get('UnsuccessfulList', [{}])[0].get('FailureReason', 'Unknown error')
                        raise Exception(f'Failed to create fresh session: {failure_reason}')
                    
                    created_session_id = create_response['SuccessfulList'][0]['Id']
                    print(f"Fresh session created: {created_session_id}")
                    
                    # Wait for fresh session to be ready
                    attempt = 0
                    while attempt < max_attempts:
                        try:
                            print(f"Fresh session attempt {attempt + 1}: Getting connection data...")
                            connection_request = urllib.request.Request(
                                f"{base_url}/sessionConnectionData/{created_session_id}/{session_owner}",
                                headers={
                                    'Authorization': f'Bearer {access_token}',
                                    'Content-Type': 'application/json'
                                }
                            )
                            
                            with safe_urlopen(connection_request, context=ssl_context, timeout=10) as response:
                                connection_data = json.loads(response.read().decode())
                                print(f"Connection data: {connection_data}")
                                break
                        except urllib.error.HTTPError as e:
                            error_body = e.read().decode() if e.fp else ''
                            if e.code == 400 and ("not in READY" in error_body or "neither in READY" in error_body):
                                attempt += 1
                                if attempt < max_attempts:
                                    print(f"Fresh session not ready, waiting 3 seconds...")
                                    time.sleep(3)  # nosemgrep: python.lang.best-practice.sleep.arbitrary-sleep
                                    continue
                            raise e
                
                if connection_data is None:
                    raise Exception(f"Session {created_session_id} did not become ready after {max_attempts} attempts")
                
                # Step 4: Construct DCV URL
                connection_token = connection_data.get('ConnectionToken')
                if not connection_token:
                    raise Exception('No connection token received')
                
                # Use regional Connection Gateway for satellite regions, otherwise use primary
                gateway_endpoint = regional_connection_gateway if regional_connection_gateway else connection_gateway_endpoint
                
                # Standard HTTPS URL for browser connections (TCP port 8443)
                dcv_url = f"https://{gateway_endpoint}:8443/?authToken={connection_token}#{created_session_id}"
                
                # QUIC URL for native DCV client (UDP port 8444) - better streaming performance
                quic_url = f"https://{gateway_endpoint}:8444/?authToken={connection_token}#{created_session_id}"
                
                print(f"DCV URL constructed using gateway: {gateway_endpoint}")
                
                return {
                    'statusCode': 200,
                    'headers': cors_headers,
                    'body': json.dumps({
                        'sessionId': created_session_id,
                        'connectionUrl': dcv_url,
                        'quicConnectionUrl': quic_url,
                        'connectionToken': connection_token
                    })
                }
                
            elif action == 'delete-session':
                if not session_id:
                    raise Exception('sessionId is required for delete-session')
                
                print(f"Deleting session {session_id}...")
                
                # First, get the session details to find the correct owner
                # Use SessionIds filter to get only the specific session
                describe_request = urllib.request.Request(
                    f"{base_url}/describeSessions",
                    data=json.dumps({
                        'SessionIds': [session_id]
                    }).encode(),
                    headers={
                        'Authorization': f'Bearer {access_token}',
                        'Content-Type': 'application/json'
                    },
                    method='POST'
                )
                
                with safe_urlopen(describe_request, context=ssl_context, timeout=10) as response:
                    sessions_data = json.loads(response.read().decode())
                
                # Find the session and get its owner
                session_owner = 'Administrator'  # default fallback
                for session in sessions_data.get('Sessions', []):
                    if session.get('Id') == session_id:
                        session_owner = session.get('Owner', 'Administrator')
                        print(f"Found session owner: {session_owner}")
                        break
                
                delete_data = [{
                    'SessionId': session_id,
                    'Owner': session_owner,
                    'Force': True
                }]
                
                request = urllib.request.Request(
                    f"{base_url}/deleteSessions",
                    data=json.dumps(delete_data).encode(),
                    headers={
                        'Authorization': f'Bearer {access_token}',
                        'Content-Type': 'application/json'
                    },
                    method='POST'
                )
                
                with safe_urlopen(request, context=ssl_context, timeout=10) as response:
                    delete_response = json.loads(response.read().decode())
                    print(f"Delete session response: {delete_response}")
                    return {
                        'statusCode': 200,
                        'headers': cors_headers,
                        'body': json.dumps({'message': 'Session deleted successfully', 'response': delete_response})
                    }
                
            elif action == 'get-load-balancers':
                print("Getting load balancer information from SSM, ELB, and regional hubs...")
                
                # Get load balancer endpoints from SSM for primary region
                pascal_case_name = os.environ.get('PASCAL_CASE_NAME', 'MediaResourceManager')
                param_prefix = f"/{pascal_case_name}/DCV"
                current_region = os.environ.get('AWS_REGION', 'us-east-1')
                
                session_manager_endpoint = ssm.get_parameter(Name=f'{param_prefix}/SessionManager/Endpoint')['Parameter']['Value']
                connection_gateway_endpoint = ssm.get_parameter(Name=f'{param_prefix}/ConnectionGateway/Endpoint')['Parameter']['Value']
                
                def get_target_group_health(endpoint, region, lb_name_pattern=None):
                    """Get target group health for a load balancer in a specific region.
                    
                    Args:
                        endpoint: The endpoint URL or DNS name
                        region: AWS region
                        lb_name_pattern: Optional pattern to match NLB name (for custom domains)
                    """
                    try:
                        elb_client = boto3.client('elbv2', region_name=region)
                        
                        # Extract load balancer DNS name from endpoint
                        lb_dns = endpoint.split('://')[1].split(':')[0] if '://' in endpoint else endpoint.split(':')[0]
                        
                        # Find load balancer by DNS name or name pattern
                        lbs = elb_client.describe_load_balancers()
                        target_lb = None
                        
                        for lb in lbs['LoadBalancers']:
                            # First try exact DNS match
                            if lb['DNSName'] == lb_dns:
                                target_lb = lb
                                break
                            # If custom domain, try matching by NLB name pattern
                            if lb_name_pattern and lb_name_pattern.lower() in lb['LoadBalancerName'].lower():
                                target_lb = lb
                                print(f"Matched NLB by name pattern '{lb_name_pattern}': {lb['LoadBalancerName']}")
                                break
                        
                        if not target_lb:
                            print(f"No NLB found for endpoint {endpoint} (dns: {lb_dns}, pattern: {lb_name_pattern})")
                            return {'healthy': 0, 'total': 0, 'status': 'Unknown'}
                        
                        # Get target groups for this load balancer
                        tgs = elb_client.describe_target_groups(LoadBalancerArn=target_lb['LoadBalancerArn'])
                        
                        total_targets = 0
                        healthy_targets = 0
                        
                        for tg in tgs['TargetGroups']:
                            # Get target health for each target group
                            health = elb_client.describe_target_health(TargetGroupArn=tg['TargetGroupArn'])
                            for target in health['TargetHealthDescriptions']:
                                total_targets += 1
                                if target['TargetHealth']['State'] == 'healthy':
                                    healthy_targets += 1
                        
                        return {
                            'healthy': healthy_targets,
                            'total': total_targets,
                            'status': 'Healthy' if healthy_targets == total_targets and total_targets > 0 else 'Degraded' if healthy_targets > 0 else 'Unhealthy'
                        }
                    except Exception as e:
                        print(f"Error getting target group health for {endpoint} in {region}: {e}")
                        return {'healthy': 0, 'total': 0, 'status': 'Unknown'}
                
                # Get health info for primary region load balancers
                # Session Manager NLB uses actual DNS, Connection Gateway may use custom domain
                sm_health = get_target_group_health(session_manager_endpoint, current_region)
                # For Connection Gateway, also try matching by name pattern in case of custom domain
                cg_health = get_target_group_health(connection_gateway_endpoint, current_region, lb_name_pattern='ConnectionGateway')
                
                load_balancers = [
                    {
                        'Name': 'DCV Session Manager',
                        'Type': 'Network Load Balancer',
                        'Endpoint': session_manager_endpoint,
                        'Port': '8443',
                        'Protocol': 'HTTPS',
                        'Purpose': 'Session Management API',
                        'Region': current_region,
                        'HealthyTargets': sm_health['healthy'],
                        'TotalTargets': sm_health['total'],
                        'HealthStatus': sm_health['status']
                    },
                    {
                        'Name': 'DCV Connection Gateway',
                        'Type': 'Network Load Balancer', 
                        'Endpoint': connection_gateway_endpoint,
                        'Port': '8443',
                        'Protocol': 'HTTPS',
                        'Purpose': 'Client Connections',
                        'Region': current_region,
                        'HealthyTargets': cg_health['healthy'],
                        'TotalTargets': cg_health['total'],
                        'HealthStatus': cg_health['status']
                    }
                ]
                
                # Query regional hubs for satellite region load balancers
                try:
                    dynamodb = boto3.resource('dynamodb')
                    regional_hubs_table = dynamodb.Table(os.environ.get('REGIONAL_HUBS_TABLE_NAME', 'regional-hubs'))
                    
                    # Scan for all regional hubs
                    hubs_response = regional_hubs_table.scan()
                    regional_hubs = hubs_response.get('Items', [])
                    
                    print(f"Found {len(regional_hubs)} regional hub(s)")
                    
                    for hub in regional_hubs:
                        hub_region = hub.get('region')
                        hub_status = hub.get('status', '').lower()
                        
                        # Skip hubs that aren't active or are in the primary region
                        if hub_region == current_region or hub_status not in ['active', 'ready', 'deployed']:
                            continue
                        
                        hub_sm_endpoint = hub.get('sessionManagerEndpoint')
                        hub_cg_endpoint = hub.get('connectionGatewayEndpoint')
                        
                        print(f"Processing regional hub: {hub_region} (status: {hub_status})")
                        
                        if hub_sm_endpoint:
                            hub_sm_health = get_target_group_health(hub_sm_endpoint, hub_region, lb_name_pattern='SessionManager')
                            load_balancers.append({
                                'Name': f'DCV Session Manager ({hub_region})',
                                'Type': 'Network Load Balancer',
                                'Endpoint': hub_sm_endpoint,
                                'Port': '8443',
                                'Protocol': 'HTTPS',
                                'Purpose': 'Session Management API',
                                'Region': hub_region,
                                'HealthyTargets': hub_sm_health['healthy'],
                                'TotalTargets': hub_sm_health['total'],
                                'HealthStatus': hub_sm_health['status']
                            })
                        
                        if hub_cg_endpoint:
                            hub_cg_health = get_target_group_health(hub_cg_endpoint, hub_region, lb_name_pattern='ConnectionGateway')
                            load_balancers.append({
                                'Name': f'DCV Connection Gateway ({hub_region})',
                                'Type': 'Network Load Balancer',
                                'Endpoint': hub_cg_endpoint,
                                'Port': '8443',
                                'Protocol': 'HTTPS',
                                'Purpose': 'Client Connections',
                                'Region': hub_region,
                                'HealthyTargets': hub_cg_health['healthy'],
                                'TotalTargets': hub_cg_health['total'],
                                'HealthStatus': hub_cg_health['status']
                            })
                            
                except Exception as e:
                    print(f"Error querying regional hubs: {e}")
                    # Continue with primary region load balancers even if regional hub query fails
                
                return {
                    'statusCode': 200,
                    'headers': cors_headers,
                    'body': json.dumps({'LoadBalancers': load_balancers})
                }
                
            elif action == 'get-autoscaling-groups':
                print("Getting autoscaling group information...")
                
                # Initialize autoscaling client
                current_region = os.environ.get('AWS_REGION', 'us-east-1')
                asg_client = boto3.client('autoscaling', region_name=current_region)
                ec2_client = boto3.client('ec2', region_name=current_region)
                
                try:
                    # Get all autoscaling groups
                    response = asg_client.describe_auto_scaling_groups()
                    
                    autoscaling_groups = []
                    for asg in response['AutoScalingGroups']:
                        # Get instance health details
                        healthy_instances = 0
                        total_instances = len(asg['Instances'])
                        
                        for instance in asg['Instances']:
                            if instance['HealthStatus'] == 'Healthy' and instance['LifecycleState'] == 'InService':
                                healthy_instances += 1
                        
                        # Determine overall health status
                        if total_instances == 0:
                            health_status = 'No instances'
                        elif healthy_instances == total_instances:
                            health_status = 'Healthy'
                        elif healthy_instances > 0:
                            health_status = 'Partially healthy'
                        else:
                            health_status = 'Unhealthy'
                        
                        autoscaling_groups.append({
                            'AutoScalingGroupName': asg['AutoScalingGroupName'],
                            'DesiredCapacity': asg['DesiredCapacity'],
                            'MinSize': asg['MinSize'],
                            'MaxSize': asg['MaxSize'],
                            'HealthyInstances': healthy_instances,
                            'TotalInstances': total_instances,
                            'HealthStatus': health_status,
                            'AvailabilityZones': asg['AvailabilityZones'],
                            'CreatedTime': asg['CreatedTime'].isoformat() if asg.get('CreatedTime') else None
                        })
                    
                    return {
                        'statusCode': 200,
                        'headers': cors_headers,
                        'body': json.dumps({'AutoScalingGroups': autoscaling_groups})
                    }
                except Exception as e:
                    print(f"Error getting autoscaling groups: {e}")
                    return {
                        'statusCode': 500,
                        'headers': cors_headers,
                        'body': json.dumps({'error': str(e)})
                    }
                
            elif action == 'get-workstation-assignments':
                print("Getting workstation assignments from DynamoDB...")
                
                try:
                    # Initialize DynamoDB client
                    current_region = os.environ.get('AWS_REGION', 'us-east-1')
                    dynamodb = boto3.resource('dynamodb', region_name=current_region)
                    table = dynamodb.Table(os.environ.get('WORKSTATION_TABLE_NAME', 'workstation-instances'))
                    users_table = dynamodb.Table(os.environ.get('USER_TABLE_NAME', 'users'))
                    groups_table = dynamodb.Table(os.environ.get('GROUPS_TABLE_NAME', 'groups'))
                    
                    # Scan the users table to build a lookup map
                    users_response = users_table.scan()
                    users_map = {}
                    for user in users_response.get('Items', []):
                        user_id = user.get('userId')
                        if user_id:
                            first_name = user.get('firstName', '')
                            last_name = user.get('lastName', '')
                            users_map[user_id] = f"{first_name} {last_name}".strip() or user_id
                    
                    # Scan the groups table to build a lookup map
                    groups_response = groups_table.scan()
                    groups_map = {}
                    for group in groups_response.get('Items', []):
                        group_id = group.get('groupId')
                        if group_id:
                            groups_map[group_id] = f"{group.get('groupName', group_id)} (Group)"
                    
                    # Scan the workstation table to get all workstation assignments
                    response = table.scan()
                    
                    # Create mappings of instanceId to assignedUserId and display name
                    assignments = {}
                    assignment_displays = {}
                    for item in response['Items']:
                        if 'instanceId' in item and 'assignedUserId' in item:
                            instance_id = item['instanceId']
                            assigned_id = item['assignedUserId']
                            assignments[instance_id] = assigned_id
                            
                            # Normalize the assigned_id for lookup
                            # Handle IdentityCenter_ prefix (e.g., "IdentityCenter_b.liu@tegna.com" -> "b.liu@tegna.com")
                            lookup_id = assigned_id
                            if assigned_id.startswith('IdentityCenter_'):
                                lookup_id = assigned_id[len('IdentityCenter_'):]
                            
                            # Look up display name - check groups first, then users
                            if assigned_id in groups_map:
                                assignment_displays[instance_id] = groups_map[assigned_id]
                            elif lookup_id in users_map:
                                assignment_displays[instance_id] = users_map[lookup_id]
                            elif assigned_id in users_map:
                                assignment_displays[instance_id] = users_map[assigned_id]
                            else:
                                # Format email for display (extract name part before @)
                                # Use lookup_id to avoid showing "Identitycenter" prefix
                                display_id = lookup_id if lookup_id != assigned_id else assigned_id
                                if '@' in display_id:
                                    assignment_displays[instance_id] = display_id.split('@')[0].replace('.', ' ').replace('_', ' ').title()
                                else:
                                    assignment_displays[instance_id] = display_id
                    
                    return {
                        'statusCode': 200,
                        'headers': cors_headers,
                        'body': json.dumps({
                            'Assignments': assignments,
                            'AssignmentDisplays': assignment_displays
                        })
                    }
                except Exception as e:
                    print(f"Error getting workstation assignments: {e}")
                    return {
                        'statusCode': 500,
                        'headers': cors_headers,
                        'body': json.dumps({'error': str(e)})
                    }
                
            elif action == 'get-instance-states':
                print("Getting EC2 instance states...")
                
                try:
                    # Initialize EC2 client
                    current_region = os.environ.get('AWS_REGION', 'us-east-1')
                    ec2_client = boto3.client('ec2', region_name=current_region)
                    
                    # Get all instances (we'll filter by the ones we care about in the frontend)
                    response = ec2_client.describe_instances()
                    
                    # Create a mapping of instanceId to state
                    instance_states = {}
                    for reservation in response['Reservations']:
                        for instance in reservation['Instances']:
                            instance_id = instance['InstanceId']
                            state = instance['State']['Name']
                            instance_states[instance_id] = state
                    
                    return {
                        'statusCode': 200,
                        'headers': cors_headers,
                        'body': json.dumps({'InstanceStates': instance_states})
                    }
                except Exception as e:
                    print(f"Error getting instance states: {e}")
                    return {
                        'statusCode': 500,
                        'headers': cors_headers,
                        'body': json.dumps({'error': str(e)})
                    }
                
            elif action == 'get-connection-data':
                if not session_id:
                    raise Exception('sessionId is required for get-connection-data')
                
                print(f"Getting connection data for session {session_id}...")
                request = urllib.request.Request(
                    f"{base_url}/session-connection-data/{session_id}",
                    headers={
                        'Authorization': f'Bearer {access_token}',
                        'Content-Type': 'application/json'
                    }
                )
                
                with safe_urlopen(request, context=ssl_context, timeout=10) as response:
                    result = json.loads(response.read().decode())
                    return {
                        'statusCode': 200,
                        'headers': cors_headers,
                        'body': json.dumps(result)
                    }
                
            else:
                raise Exception(f'Unknown action: {action}')
                
        except urllib.error.HTTPError as e:
            error_body = e.read().decode() if e.fp else str(e)
            print(f"HTTP error {e.code}: {error_body}")
            print(f"Response headers: {dict(e.headers) if hasattr(e, 'headers') else 'None'}")
            print(f"URL that failed: {e.url if hasattr(e, 'url') else 'Unknown'}")
            return {
                'statusCode': 500,
                'headers': cors_headers,
                'body': json.dumps({'error': f'HTTP {e.code}: {error_body}', 'url': getattr(e, 'url', 'Unknown')})
            }
        except Exception as e:
            print(f"API request error: {e}")
            return {
                'statusCode': 500,
                'headers': cors_headers,
                'body': json.dumps({'error': f'API request failed: {str(e)}'})
            }
                
    except Exception as e:
        print(f"General error: {e}")
        return {
            'statusCode': 500,
            'headers': cors_headers,
            'body': json.dumps({'error': str(e)})
        }
