# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

import json
import os
import boto3

def lambda_handler(event, context):
    """
    Manual cleanup function that can clean up all stale DCV servers.
    Can be called via API Gateway or directly.
    """
    print(f'Manual DCV cleanup event: {json.dumps(event, indent=2)}')
    
    # Get pascal case name from environment variable
    pascal_case_name = os.environ.get('PASCAL_CASE_NAME', 'MediaResourceManager')
    
    # Import the cleanup function
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

    try:
        # Get SSM parameters
        ssm = boto3.client('ssm')
        
        session_manager_dns = ssm.get_parameter(Name=f'/{pascal_case_name}/DCV/SessionManager/Endpoint')['Parameter']['Value']
        client_id = ssm.get_parameter(Name=f'/{pascal_case_name}/DCV/SessionManager/ClientId')['Parameter']['Value']
        client_password = ssm.get_parameter(Name=f'/{pascal_case_name}/DCV/SessionManager/ClientPassword', WithDecryption=True)['Parameter']['Value']
        
        print(f'Got parameters - private_dns: {session_manager_dns}')
        
        # Create SSL context
        ssl_context = ssl.create_default_context()
        ssl_context.check_hostname = False
        ssl_context.verify_mode = ssl.CERT_NONE
        
        # Get OAuth2 token
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
        
        base_url = f"https://{session_manager_dns}:8443"
        
        # Get all servers
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
            servers = servers_data.get('Servers', [])
        
        # Get all running instances
        ec2 = boto3.client('ec2')
        running_instances = set()
        
        try:
            response = ec2.describe_instances(
                Filters=[{'Name': 'instance-state-name', 'Values': ['running', 'pending', 'stopping']}]
            )
            for reservation in response['Reservations']:
                for instance in reservation['Instances']:
                    running_instances.add(instance['InstanceId'])
        except Exception as e:
            print(f"Error getting running instances: {e}")
            return {'success': False, 'error': str(e)}
        
        # Find stale servers
        stale_servers = []
        for server in servers:
            server_instance_id = server.get('Host', {}).get('Aws', {}).get('EC2InstanceId')
            if server_instance_id and server_instance_id not in running_instances:
                stale_servers.append({
                    'id': server.get('Id'),
                    'instanceId': server_instance_id,
                    'availability': server.get('Availability')
                })
        
        print(f"Found {len(stale_servers)} stale servers to clean up")
        
        # Clean up stale servers
        cleaned_count = 0
        for server_info in stale_servers:
            server_id = server_info['id']
            instance_id = server_info['instanceId']
            
            try:
                # Delete server
                remove_request = urllib.request.Request(
                    f"{base_url}/servers/{server_id}",
                    headers={
                        'Authorization': f'Bearer {access_token}',
                        'Content-Type': 'application/json'
                    },
                    method='DELETE'
                )
                
                with safe_urlopen(remove_request, context=ssl_context, timeout=10) as response:
                    print(f"Removed stale server {server_id} for instance {instance_id}")
                    cleaned_count += 1
                    
            except Exception as e:
                print(f"Failed to remove server {server_id}: {e}")
        
        return {
            'success': True,
            'totalServers': len(servers),
            'runningInstances': len(running_instances),
            'staleServers': len(stale_servers),
            'cleanedUp': cleaned_count,
            'message': f'Cleaned up {cleaned_count} of {len(stale_servers)} stale servers'
        }
        
    except Exception as error:
        print(f"Manual cleanup failed: {error}")
        return {'success': False, 'error': str(error)}