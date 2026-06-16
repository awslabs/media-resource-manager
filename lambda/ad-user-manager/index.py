# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

import json
import boto3
import logging
import time
import urllib3
import os
from datetime import datetime
from botocore.exceptions import ClientError

logger = logging.getLogger()
logger.setLevel(logging.INFO)

def lambda_handler(event, context):
    try:
        logger.info(f"Event: {json.dumps(event)}")
        
        request_type = event['RequestType']
        resource_properties = event['ResourceProperties']
        
        if request_type == 'Create':
            create_ad_user(resource_properties)
        elif request_type == 'Update':
            # For updates, we also create/update the user
            create_ad_user(resource_properties)
        elif request_type == 'Delete':
            delete_ad_user(resource_properties)
        
        send_response(event, context, 'SUCCESS', {})
        
    except Exception as e:
        logger.error(f"Error: {str(e)}")
        send_response(event, context, 'FAILED', {})

def create_dynamodb_user(username, is_admin):
    """Create user entry in DynamoDB table - only for ResourceAdmin user"""
    # Only create DynamoDB entry for ResourceAdmin user, not service accounts
    if username != 'ResourceAdmin':
        logger.info(f"Skipping DynamoDB entry for service account: {username}")
        return
        
    user_table_name = os.environ.get('USER_TABLE_NAME')
    if not user_table_name:
        logger.warning("USER_TABLE_NAME environment variable not set, skipping DynamoDB user creation")
        return
    
    # Get AD domain from SSM parameter or environment
    try:
        ssm = boto3.client('ssm')
        # Try to get domain from SSM parameter (will be available after AD creation)
        domain_response = ssm.get_parameter(Name=f"/{os.environ.get('PASCAL_CASE_NAME', 'MediaResourceManager')}/Identity/ActiveDirectoryDomainName")
        ad_domain = domain_response['Parameter']['Value']
    except:
        # Fallback to default domain if SSM parameter not available yet
        ad_domain = 'studio.mrm.internal'
    
    dynamodb = boto3.resource('dynamodb')
    table = dynamodb.Table(user_table_name)
    
    # Create user item matching the schema
    user_item = {
        'userId': username,
        'createdAt': datetime.utcnow().isoformat() + 'Z',
        'department': 'Administration',
        'email': f'{username.lower()}@{ad_domain}',
        'firstName': 'Resource',
        'lastName': 'Admin',
        'isAdmin': is_admin,
        'preferences': {}
    }
    
    try:
        table.put_item(Item=user_item)
        logger.info(f"Created DynamoDB user entry for: {username} with email: {user_item['email']}")
    except Exception as e:
        logger.error(f"Error creating DynamoDB user entry for {username}: {str(e)}")
        # Don't fail the whole operation if DynamoDB write fails
        
def delete_dynamodb_user(username):
    """Delete user entry from DynamoDB table - only for ResourceAdmin user"""
    # Only delete DynamoDB entry for ResourceAdmin user, not service accounts
    if username != 'ResourceAdmin':
        logger.info(f"Skipping DynamoDB deletion for service account: {username}")
        return
        
    user_table_name = os.environ.get('USER_TABLE_NAME')
    if not user_table_name:
        logger.warning("USER_TABLE_NAME environment variable not set, skipping DynamoDB user deletion")
        return
    
    dynamodb = boto3.resource('dynamodb')
    table = dynamodb.Table(user_table_name)
    
    try:
        table.delete_item(Key={'userId': username})
        logger.info(f"Deleted DynamoDB user entry for: {username}")
    except Exception as e:
        logger.error(f"Error deleting DynamoDB user entry for {username}: {str(e)}")
        # Don't fail the whole operation if DynamoDB delete fails

def create_ad_user(properties):
    """Create AD user using AWS Directory Service Data API"""
    # Use ds-data client (correct service name for boto3)
    ds_data_client = boto3.client('ds-data')
    ds_client = boto3.client('ds')  # For password reset
    secrets_client = boto3.client('secretsmanager')
    
    directory_id = properties['DirectoryId']
    username = properties['Username']
    secret_arn = properties['SecretArn']
    is_admin = properties.get('IsAdmin', 'false').lower() == 'true'
    
    # Get password from secrets manager
    secret_response = secrets_client.get_secret_value(SecretId=secret_arn)
    secret_data = json.loads(secret_response['SecretString'])
    password = secret_data['password']
    
    # Sanitize username like the working code
    sanitized_username = ''.join(c for c in username if c.isalnum() or c in '-_.')
    
    # Create user using DirectoryServiceData API
    try:
        response = ds_data_client.create_user(
            DirectoryId=directory_id,
            SAMAccountName=sanitized_username,
            GivenName=username,
            Surname='User'
        )
        logger.info(f"Created user: {sanitized_username}")
        
        # Reset password to enable the user with retry logic
        max_retries = 3
        for attempt in range(max_retries):
            try:
                ds_client.reset_user_password(
                    DirectoryId=directory_id,
                    UserName=sanitized_username,
                    NewPassword=password
                )
                logger.info(f"Set password for user: {sanitized_username}")
                break
            except ClientError as e:
                if e.response['Error']['Code'] == 'InvalidPasswordException' and attempt < max_retries - 1:
                    wait_time = 2 ** attempt  # Exponential backoff: 1s, 2s, 4s
                    logger.info(f"Password reset failed (attempt {attempt + 1}), retrying in {wait_time}s...")
                    time.sleep(wait_time)  # nosemgrep: python.lang.best-practice.sleep.arbitrary-sleep
                else:
                    raise
        
        # Set password to never expire for service accounts
        # nosemgrep: python.lang.best-practice.sleep.arbitrary-sleep
        time.sleep(2)  # Brief wait for user creation to propagate
        try:
            ds_data_client.update_user(
                DirectoryId=directory_id,
                SAMAccountName=sanitized_username,
                OtherAttributes={
                    'userAccountControl': {
                        'Value': '66048'  # NORMAL_ACCOUNT (512) + DONT_EXPIRE_PASSWORD (65536) = 66048
                    }
                }
            )
            logger.info(f"Set password to never expire for user: {sanitized_username}")
        except Exception as e:
            logger.warning(f"Could not set password never expire for {sanitized_username}: {str(e)}")
        
        # Add to AWS Delegated Administrators group if admin
        if is_admin:
            try:
                ds_data_client.add_group_member(
                    DirectoryId=directory_id,
                    GroupName='AWS Delegated Administrators',
                    MemberName=sanitized_username
                )
                logger.info(f"Added admin user {sanitized_username} to AWS Delegated Administrators group")
            except Exception as e:
                logger.warning(f"Could not add admin user {sanitized_username} to group: {str(e)}")
        
        # Create DynamoDB user entry
        create_dynamodb_user(sanitized_username, is_admin)
                
    except ClientError as e:
        error_code = e.response['Error']['Code']
        if error_code == 'ConflictException' and 'already exists' in str(e):
            logger.info(f"User {sanitized_username} already exists")
            
            # Set password to never expire for existing user
            try:
                ds_data_client.update_user(
                    DirectoryId=directory_id,
                    SAMAccountName=sanitized_username,
                    OtherAttributes={
                        'userAccountControl': {
                            'Value': '66048'  # NORMAL_ACCOUNT (512) + DONT_EXPIRE_PASSWORD (65536) = 66048
                        }
                    }
                )
                logger.info(f"Set password to never expire for existing user: {sanitized_username}")
            except Exception as e:
                logger.warning(f"Could not set password never expire for existing {sanitized_username}: {str(e)}")
            
            # Try to add to admin group if needed
            if is_admin:
                try:
                    ds_data_client.add_group_member(
                        DirectoryId=directory_id,
                        GroupName='AWS Delegated Administrators',
                        MemberName=sanitized_username
                    )
                    logger.info(f"Added existing admin user {sanitized_username} to AWS Delegated Administrators group")
                except Exception as e:
                    logger.warning(f"Could not add existing admin user {sanitized_username} to group: {str(e)}")
            
            # Create DynamoDB user entry (will overwrite if exists)
            create_dynamodb_user(sanitized_username, is_admin)
        else:
            logger.error(f"Error creating user {sanitized_username}: {str(e)}")
            raise
    except Exception as e:
        logger.error(f"Error creating user {sanitized_username}: {str(e)}")
        raise

def delete_ad_user(properties):
    """Delete AD user"""
    ds_data_client = boto3.client('ds-data')
    
    directory_id = properties['DirectoryId']
    username = properties['Username']
    
    # Sanitize username
    sanitized_username = ''.join(c for c in username if c.isalnum() or c in '-_.')
    
    try:
        # Remove from admin group first if needed
        try:
            ds_data_client.remove_group_member(
                DirectoryId=directory_id,
                GroupName='AWS Delegated Administrators',
                MemberName=sanitized_username
            )
            logger.info(f"Removed user {sanitized_username} from AWS Delegated Administrators group")
        except Exception as e:
            logger.info(f"User {sanitized_username} was not in admin group or error removing: {str(e)}")
        
        # Delete the user
        ds_data_client.delete_user(
            DirectoryId=directory_id,
            SAMAccountName=sanitized_username
        )
        logger.info(f"Deleted user: {sanitized_username}")
        
        # Delete DynamoDB user entry
        delete_dynamodb_user(sanitized_username)
        
    except ClientError as e:
        error_code = e.response['Error']['Code']
        if error_code == 'ResourceNotFoundException':
            logger.info(f"User {sanitized_username} does not exist")
            # Still try to delete from DynamoDB in case it exists there
            delete_dynamodb_user(sanitized_username)
        else:
            logger.error(f"Error deleting user {sanitized_username}: {str(e)}")
    except Exception as e:
        logger.error(f"Error deleting user {sanitized_username}: {str(e)}")

def send_response(event, context, response_status, response_data):
    """Send response to CloudFormation"""
    response_url = event['ResponseURL']
    
    response_body = {
        'Status': response_status,
        'Reason': f'See CloudWatch Log Stream: {context.log_stream_name}',
        'PhysicalResourceId': context.log_stream_name,
        'StackId': event['StackId'],
        'RequestId': event['RequestId'],
        'LogicalResourceId': event['LogicalResourceId'],
        'Data': response_data
    }
    
    json_response_body = json.dumps(response_body)
    
    headers = {
        'content-type': '',
        'content-length': str(len(json_response_body))
    }
    
    try:
        http = urllib3.PoolManager()
        response = http.request('PUT', response_url, body=json_response_body, headers=headers)
        logger.info(f"Status code: {response.status}")
    except Exception as e:
        logger.error(f"send_response failed: {str(e)}")
