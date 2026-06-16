# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

import json
import boto3
import os
from datetime import datetime, timezone
from decimal import Decimal

dynamodb = boto3.resource('dynamodb')
progress_table_name = os.environ['PROGRESS_TABLE_NAME']
workstation_table_name = os.environ.get('WORKSTATION_TABLE_NAME', 'workstation-instances')
progress_table = dynamodb.Table(progress_table_name)
workstation_table = dynamodb.Table(workstation_table_name)

def lambda_handler(event, context):
    try:
        # Extract progress information from the event
        instance_id = event['instanceId']
        stage = event['stage']
        status = event['status']
        message = event.get('message', '')
        progress = event.get('progress', 0)
        
        # Create timestamp
        timestamp = datetime.now(timezone.utc).isoformat()
        
        # Put item in progress table with TTL (24 hours)
        ttl = int(datetime.now(timezone.utc).timestamp()) + 86400
        
        progress_table.put_item(
            Item={
                'instanceId': instance_id,
                'timestamp': timestamp,
                'stage': stage,
                'status': status,
                'message': message,
                'progress': Decimal(str(progress)),
                'ttl': ttl
            }
        )
        
        # Also update the workstation-instances table with workflow status
        # Map stage values to title-case status values the frontend expects
        stage_to_status = {
            'complete': 'Complete',
            'starting-instance': 'Starting',
            'instance-running': 'Running',
            'configuring-autologin': 'Configuring',
            'starting-dcv-agents': 'Starting DCV',
            'dcv-ready': 'DCV Ready',
        }
        update_expression_parts = ['#st = :workflowStatus']
        expression_attribute_names = {'#st': 'status'}
        expression_attribute_values = {':workflowStatus': stage_to_status.get(stage, stage)}
        
        # Set dcvStatus to 'ready' when complete
        if stage == 'complete' and progress == 100:
            update_expression_parts.append('dcvStatus = :dcvStatus')
            expression_attribute_values[':dcvStatus'] = 'ready'
        
        workstation_table.update_item(
            Key={'instanceId': instance_id},
            UpdateExpression='SET ' + ', '.join(update_expression_parts),
            ExpressionAttributeNames=expression_attribute_names,
            ExpressionAttributeValues=expression_attribute_values
        )
        
        return {
            'statusCode': 200,
            'body': json.dumps({
                'instanceId': instance_id,
                'stage': stage,
                'status': status,
                'timestamp': timestamp
            })
        }
        
    except Exception as e:
        print(f"Error publishing progress: {str(e)}")
        return {
            'statusCode': 500,
            'body': json.dumps({'error': str(e)})
        }
