# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

import json
import boto3
import logging
import time
import os
from datetime import datetime
from botocore.exceptions import ClientError

logger = logging.getLogger()
logger.setLevel(logging.INFO)

def lambda_handler(event, context):
    """onEvent handler for the CDK custom resource provider framework.

    The framework sends the response to CloudFormation: returning reports
    SUCCESS (keeping the existing physical resource ID on Update), raising
    reports FAILED.
    """
    logger.info(f"Event: {json.dumps({**event, 'ResponseURL': '[REDACTED]'} if 'ResponseURL' in event else event)}")

    request_type = event['RequestType']
    resource_properties = event['ResourceProperties']

    if request_type == 'Create':
        create_ad_user(resource_properties)
    elif request_type == 'Update':
        # The user already exists. Set its password to the stored value, which
        # also restarts the directory's maximum password age for it.
        reset_password_to_stored_value(
            resource_properties['DirectoryId'],
            sanitize_username(resource_properties['Username']),
            resource_properties['SecretArn'],
        )
    elif request_type == 'Delete':
        delete_ad_user(resource_properties)

    return {}

def scheduled_reset_handler(event, context):
    """EventBridge schedule: set ResourceAdmin's password to its stored value.

    AWS Managed Microsoft AD expires passwords after the directory's maximum
    password age (42 days by default), and the Directory Service APIs cannot
    mark a password as never expiring. An administrative reset to the same
    value restarts the password age without changing the password that
    anything else holds. Raises on failure so the error shows in the
    function's Errors metric and alarm.
    """
    try:
        reset_password_to_stored_value(
            os.environ['DIRECTORY_ID'],
            sanitize_username(os.environ['USERNAME']),
            os.environ['SECRET_ARN'],
        )
    except Exception as e:
        logger.error(f"Scheduled password reset failed: {type(e).__name__}: {e}")
        raise
    return {'status': 'reset'}

def sanitize_username(username):
    return ''.join(c for c in username if c.isalnum() or c in '-_.')

def read_stored_password(secret_arn):
    secrets_client = boto3.client('secretsmanager')
    secret_response = secrets_client.get_secret_value(SecretId=secret_arn)
    return json.loads(secret_response['SecretString'])['password']

def reset_password(directory_id, username, password):
    """ds:ResetUserPassword, retrying while a just-created user propagates."""
    ds_client = boto3.client('ds')
    max_retries = 3
    for attempt in range(max_retries):
        try:
            ds_client.reset_user_password(
                DirectoryId=directory_id,
                UserName=username,
                NewPassword=password
            )
            logger.info(f"Set password for user: {username}")
            return
        except ClientError as e:
            if e.response['Error']['Code'] == 'InvalidPasswordException' and attempt < max_retries - 1:
                wait_time = 2 ** attempt  # Exponential backoff: 1s, 2s, 4s
                logger.info(f"Password reset failed (attempt {attempt + 1}), retrying in {wait_time}s...")
                time.sleep(wait_time)  # nosemgrep: python.lang.best-practice.sleep.arbitrary-sleep
            else:
                raise

def reset_password_to_stored_value(directory_id, username, secret_arn):
    reset_password(directory_id, username, read_stored_password(secret_arn))

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
        logger.info(f"Created DynamoDB user entry for: {username}")
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
    """Create the AD user (or adopt an existing one) and set its password to the stored value."""
    ds_data_client = boto3.client('ds-data')

    directory_id = properties['DirectoryId']
    username = properties['Username']
    secret_arn = properties['SecretArn']
    is_admin = properties.get('IsAdmin', 'false').lower() == 'true'
    sanitized_username = sanitize_username(username)

    try:
        ds_data_client.create_user(
            DirectoryId=directory_id,
            SAMAccountName=sanitized_username,
            GivenName=username,
            Surname='User'
        )
        logger.info(f"Created user: {sanitized_username}")
    except ClientError as e:
        if e.response['Error']['Code'] != 'ConflictException':
            raise
        logger.info(f"User {sanitized_username} already exists")

    # Setting the password also enables the user.
    reset_password_to_stored_value(directory_id, sanitized_username, secret_arn)

    if is_admin:
        # nosemgrep: python.lang.best-practice.sleep.arbitrary-sleep
        time.sleep(2)  # Brief wait for user creation to propagate
        try:
            ds_data_client.add_group_member(
                DirectoryId=directory_id,
                GroupName='AWS Delegated Administrators',
                MemberName=sanitized_username
            )
            logger.info(f"Added admin user {sanitized_username} to AWS Delegated Administrators group")
        except Exception as e:
            logger.warning(f"Could not add admin user {sanitized_username} to group: {str(e)}")

    create_dynamodb_user(sanitized_username, is_admin)

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
