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
from datetime import datetime

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
    print("Starting DCV connection status sync...")
    
    # Get pascal case name from environment variable
    pascal_case_name = os.environ.get('PASCAL_CASE_NAME', 'MediaResourceManager')
    workstation_table_name = os.environ.get('WORKSTATION_TABLE_NAME', 'workstation-instances')
    
    # Initialize clients
    dynamodb = boto3.resource('dynamodb')
    ssm = boto3.client('ssm')
    table = dynamodb.Table(workstation_table_name)
    
    try:
        # Get SSM parameters for DCV Session Manager
        print("Getting SSM parameters...")
        client_id = ssm.get_parameter(Name=f'/{pascal_case_name}/DCV/SessionManager/ClientId')['Parameter']['Value']
        client_password = ssm.get_parameter(Name=f'/{pascal_case_name}/DCV/SessionManager/ClientPassword', WithDecryption=True)['Parameter']['Value']
        private_dns = ssm.get_parameter(Name=f'/{pascal_case_name}/DCV/SessionManager/Endpoint')['Parameter']['Value']
        
        # Create SSL context
        ssl_context = ssl.create_default_context()
        ssl_context.check_hostname = False
        ssl_context.verify_mode = ssl.CERT_NONE
        
        # Get OAuth2 token
        print("Getting OAuth2 token...")
        token_url = f"https://{private_dns}:8443/oauth2/token?grant_type=client_credentials"
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
        
        base_url = f"https://{private_dns}:8443"
        
        # Get all servers
        print("Getting server list...")
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
        
        # Get all sessions
        print("Getting session list...")
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
            sessions_data = json.loads(response.read().decode())
        
        # Process each server and match to DynamoDB instances by IP
        ec2 = boto3.client('ec2')
        
        for server in servers_data.get('Servers', []):
            server_ip = server.get('Ip')
            if not server_ip:
                continue
            
            # Find EC2 instance by private IP
            try:
                ec2_response = ec2.describe_instances(
                    Filters=[
                        {'Name': 'private-ip-address', 'Values': [server_ip]},
                        {'Name': 'instance-state-name', 'Values': ['running', 'stopped', 'stopping']}
                    ]
                )
                
                instance_id = None
                instance_state = None
                for reservation in ec2_response['Reservations']:
                    for instance in reservation['Instances']:
                        if instance['PrivateIpAddress'] == server_ip:
                            instance_id = instance['InstanceId']
                            instance_state = instance['State']['Name']
                            break
                    if instance_id:
                        break
                
                if not instance_id:
                    continue
                    
            except Exception as e:
                print(f"Error finding instance for IP {server_ip}: {e}")
                continue
                
            print(f"Processing server for instance {instance_id}")
            
            # Find sessions for this server
            server_sessions = []
            for session in sessions_data.get('Sessions', []):
                if session.get('Server', {}).get('Id') == server.get('Id'):
                    server_sessions.append(session)
            
            # Calculate connection metrics
            total_connections = sum(session.get('NumOfConnections', 0) for session in server_sessions)
            
            # Find the most recent session for state info
            latest_session = None
            latest_time = None
            for session in server_sessions:
                if session.get('State') in ['READY', 'CREATING']:
                    creation_time = session.get('CreationTime')
                    if creation_time and (not latest_time or creation_time > latest_time):
                        latest_session = session
                        latest_time = creation_time
            
            # Prepare update data
            update_data = {
                'connectionCount': total_connections,
                'lastStatusCheck': datetime.utcnow().isoformat() + 'Z',
                'instanceStatus': instance_state  # Add EC2 instance state
            }
            
            if latest_session:
                update_data['sessionState'] = latest_session.get('State', 'UNKNOWN')
                update_data['dcvSessionId'] = latest_session.get('Id')
                
                # Add last disconnection time if available
                last_disconnect = latest_session.get('LastDisconnectionTime')
                if last_disconnect:
                    update_data['lastDisconnectionTime'] = last_disconnect
            else:
                update_data['sessionState'] = 'NO_SESSION'
                update_data['dcvSessionId'] = None
            
            # Update DynamoDB
            try:
                table.update_item(
                    Key={'instanceId': instance_id},
                    UpdateExpression='SET connectionCount = :cc, sessionState = :ss, lastStatusCheck = :lsc, dcvSessionId = :sid, instanceStatus = :ist' + 
                                   (', lastDisconnectionTime = :ldt' if 'lastDisconnectionTime' in update_data else ''),
                    ExpressionAttributeValues={
                        ':cc': update_data['connectionCount'],
                        ':ss': update_data['sessionState'],
                        ':lsc': update_data['lastStatusCheck'],
                        ':sid': update_data['dcvSessionId'],
                        ':ist': update_data['instanceStatus'],
                        **(
                            {':ldt': update_data['lastDisconnectionTime']} 
                            if 'lastDisconnectionTime' in update_data else {}
                        )
                    },
                    ConditionExpression='attribute_exists(instanceId)'
                )
                print(f"Updated status for instance {instance_id}: {total_connections} connections, state: {update_data['sessionState']}")
                
            except dynamodb.meta.client.exceptions.ConditionalCheckFailedException:
                print(f"Instance {instance_id} not found in workstation table - skipping")
            except Exception as e:
                print(f"Error updating instance {instance_id}: {e}")
        
        print("DCV connection status sync completed successfully")
        return {
            'statusCode': 200,
            'body': json.dumps({'message': 'Status sync completed'})
        }
        
    except Exception as e:
        print(f"Error in status sync: {e}")
        return {
            'statusCode': 500,
            'body': json.dumps({'error': str(e)})
        }