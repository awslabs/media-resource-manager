# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

import json
import boto3
import urllib3
import os

def send_response(event, context, status, data=None):
    """Send response back to CloudFormation"""
    if 'ResponseURL' not in event:
        return
    
    response_body = {
        'Status': status,
        'Reason': f'See CloudWatch Log Stream: {context.log_stream_name}',
        'PhysicalResourceId': context.log_stream_name,
        'StackId': event['StackId'],
        'RequestId': event['RequestId'],
        'LogicalResourceId': event['LogicalResourceId'],
        'Data': data or {}
    }
    
    http = urllib3.PoolManager()
    response = http.request('PUT', event['ResponseURL'], 
                          body=json.dumps(response_body),
                          headers={'Content-Type': 'application/json'})
    print(f"Response status: {response.status}")


def update_cognito_callback_urls(frontend_url, pascal_case_name):
    """Update Cognito User Pool Client callback URLs with the real frontend URL"""
    ssm = boto3.client('ssm')
    cognito = boto3.client('cognito-idp')
    
    try:
        # Get User Pool ID and Client ID from SSM
        user_pool_id = ssm.get_parameter(Name=f'/{pascal_case_name}/Auth/UserPoolId')['Parameter']['Value']
        client_id = ssm.get_parameter(Name=f'/{pascal_case_name}/Auth/UserPoolClientId')['Parameter']['Value']
        
        print(f"Updating Cognito client {client_id} in pool {user_pool_id}")
        
        # Get current client config to preserve existing settings
        client_config = cognito.describe_user_pool_client(
            UserPoolId=user_pool_id,
            ClientId=client_id
        )['UserPoolClient']
        
        # List identity providers to preserve them
        providers_response = cognito.list_identity_providers(
            UserPoolId=user_pool_id,
            MaxResults=60
        )
        
        providers = providers_response.get('Providers', [])
        supported_providers = ['COGNITO'] + [p['ProviderName'] for p in providers]
        # Remove duplicates while preserving order
        supported_providers = list(dict.fromkeys(supported_providers))
        
        # Normalize frontend URL - remove trailing slash for consistency
        base_url = frontend_url.rstrip('/')
        
        # Build callback/logout URLs - include both with and without trailing slash
        # window.location.origin returns URL without trailing slash
        callback_urls = [base_url, f'{base_url}/', 'http://localhost:3000', 'http://localhost:3000/']
        logout_urls = [base_url, f'{base_url}/', 'http://localhost:3000', 'http://localhost:3000/']
        
        print(f'Setting callback URLs: {callback_urls}')
        print(f'Supported providers: {supported_providers}')
        
        # Update the user pool client with real URLs
        cognito.update_user_pool_client(
            UserPoolId=user_pool_id,
            ClientId=client_id,
            SupportedIdentityProviders=supported_providers,
            AllowedOAuthFlowsUserPoolClient=True,
            AllowedOAuthFlows=['code'],
            AllowedOAuthScopes=['email', 'openid', 'profile'],
            CallbackURLs=callback_urls,
            LogoutURLs=logout_urls,
            ExplicitAuthFlows=client_config.get('ExplicitAuthFlows', [
                'ALLOW_USER_SRP_AUTH',
                'ALLOW_ADMIN_USER_PASSWORD_AUTH',
                'ALLOW_USER_PASSWORD_AUTH',
                'ALLOW_REFRESH_TOKEN_AUTH',
            ]),
        )
        
        print('Successfully updated Cognito callback URLs')
        return True
    except Exception as e:
        print(f'Error updating Cognito callback URLs: {e}')
        # Don't fail - this is a best-effort update
        return False


def handler(event, context):
    print(f"Event: {json.dumps(event)}")
    
    # Always send response for CloudFormation custom resources
    is_custom_resource = 'RequestType' in event
    pascal_case_name = os.environ.get('PASCAL_CASE_NAME', 'MediaResourceManager')
    
    try:
        # Check if this is a CloudFormation custom resource call
        if is_custom_resource:
            # Handle DELETE requests - just return success
            if event['RequestType'] == 'Delete':
                print("Delete request - returning success")
                send_response(event, context, 'SUCCESS')
                return
                
            # Custom resource call - use FrontendUrl from properties
            frontend_url = event['ResourceProperties'].get('FrontendUrl')
            if not frontend_url:
                print("No FrontendUrl in properties, skipping CORS update")
                send_response(event, context, 'SUCCESS')
                return
        else:
            # EventBridge call - get from SSM parameter
            if 'source' in event and event['source'] == 'aws.ssm':
                parameter_name = event['detail']['name']
                
                if f'/{pascal_case_name}/Frontend/Url' not in parameter_name:
                    return
            
            # Get the frontend URL from parameter store
            ssm = boto3.client('ssm')
            try:
                param_name = f'/{pascal_case_name}/Frontend/Url'
                
                print(f"Getting parameter: {param_name}")
                frontend_url = ssm.get_parameter(Name=param_name)['Parameter']['Value']
            except Exception as e:
                print(f"Could not get frontend URL from SSM: {e}")
                if is_custom_resource:
                    send_response(event, context, 'FAILED')
                return
        
        # Update Cognito callback URLs with the real frontend URL
        update_cognito_callback_urls(frontend_url, pascal_case_name)
        
        # Get API Gateway ID from environment variable
        api_id = os.environ.get('API_ID')
        if not api_id:
            print("No API_ID environment variable found")
            if is_custom_resource:
                send_response(event, context, 'SUCCESS')  # Don't fail deployment for missing API
            return
        
        print(f"Updating CORS for API {api_id} with frontend URL {frontend_url}")
        
        # Update CORS configuration
        apigateway = boto3.client('apigateway')
        
        # Get all resources with pagination
        all_resources = []
        position = None
        while True:
            if position:
                resources = apigateway.get_resources(restApiId=api_id, limit=500, position=position)
            else:
                resources = apigateway.get_resources(restApiId=api_id, limit=500)
            
            all_resources.extend(resources['items'])
            position = resources.get('position')
            if not position:
                break
        
        print(f"Total resources found: {len(all_resources)}")
        resources_with_options = [r for r in all_resources if 'OPTIONS' in r.get('resourceMethods', {})]
        print(f"Resources with OPTIONS: {len(resources_with_options)}")
        print(f"Resource IDs with OPTIONS: {[r['id'] for r in resources_with_options]}")
        
        # Update CORS for each resource that has OPTIONS method
        updated_resources = 0
        for resource in all_resources:
            if 'OPTIONS' in resource.get('resourceMethods', {}):
                try:
                    # Update the integration response
                    apigateway.update_integration_response(
                        restApiId=api_id,
                        resourceId=resource['id'],
                        httpMethod='OPTIONS',
                        statusCode='204',
                        patchOperations=[
                            {
                                'op': 'replace',
                                'path': '/responseParameters/method.response.header.Access-Control-Allow-Origin',
                                'value': f"'{frontend_url}'"
                            }
                        ]
                    )
                    print(f"Updated CORS for resource {resource['id']}")
                    updated_resources += 1
                except Exception as e:
                    print(f"Error updating resource {resource['id']}: {e}")
        
        # Create a new deployment to apply changes
        print(f"Attempting to create deployment for API {api_id}")
        try:
            deployment = apigateway.create_deployment(
                restApiId=api_id,
                stageName='prod'
            )
            print(f"SUCCESS: Created deployment {deployment['id']} for API {api_id}")
            print(f'CORS updated for API {api_id} with frontend URL {frontend_url}. Updated {updated_resources} resources.')
        except Exception as e:
            print(f"FAILED: Error creating deployment for API {api_id}: {str(e)}")
            import traceback
            print(f"Full traceback: {traceback.format_exc()}")
        
        # Send success response for custom resource
        if is_custom_resource:
            send_response(event, context, 'SUCCESS')
        
    except Exception as e:
        print(f"Error: {e}")
        import traceback
        traceback.print_exc()
        
        # Always send response for custom resource to prevent hanging
        if is_custom_resource:
            send_response(event, context, 'FAILED')
        else:
            raise e
