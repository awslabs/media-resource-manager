# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

import json
import os
import boto3
from boto3.dynamodb.conditions import Key
from datetime import datetime, timedelta
from decimal import Decimal

def decimal_default(obj):
    """JSON serializer for Decimal objects"""
    if isinstance(obj, Decimal):
        return int(obj) if obj % 1 == 0 else float(obj)
    raise TypeError

def handler(event, context):
    """Get workstation start progress events"""
    
    # CORS headers for all responses
    cors_headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type,Authorization',
        'Access-Control-Allow-Methods': 'GET,OPTIONS'
    }
    
    # Extract instance ID from query parameters
    instance_id = event.get('queryStringParameters', {}).get('instanceId')
    if not instance_id:
        return {
            'statusCode': 400,
            'headers': cors_headers,
            'body': json.dumps({'error': 'instanceId required'})
        }
    
    dynamodb = boto3.resource('dynamodb')
    progress_table = dynamodb.Table(os.environ.get('PROGRESS_TABLE_NAME', 'workstation-progress'))
    
    try:
        # Get latest progress events for this instance
        response = progress_table.query(
            KeyConditionExpression=Key('instanceId').eq(instance_id),
            ScanIndexForward=False,  # Latest first
            Limit=50  # Increased limit to ensure we get all events for this instance
        )
        
        events = []
        if response['Items']:
            # Sort items by timestamp (chronological order for processing)
            sorted_items = sorted(response['Items'], key=lambda x: x['timestamp'])
            
            # Find the most recent "starting-instance" event for this specific instance
            current_run_start = None
            for item in reversed(sorted_items):  # Start from most recent
                if item['stage'] == 'starting-instance' and item['instanceId'] == instance_id:
                    current_run_start = item['timestamp']
                    break
            
            # Only include events from the current run for this specific instance
            if current_run_start:
                for item in sorted_items:  # Chronological order
                    if (item['timestamp'] >= current_run_start and 
                        item['instanceId'] == instance_id):
                        # Convert all Decimal objects to appropriate types
                        event = {
                            'timestamp': item['timestamp'],
                            'stage': item['stage'],
                            'status': item['status'],
                            'message': item.get('message', ''),
                            'progress': int(item.get('progress', 0)) if isinstance(item.get('progress'), Decimal) else item.get('progress', 0)
                        }
                        events.append(event)
        
        print(f"Returning {len(events)} events for instance {instance_id}")  # Debug logging
        
        return {
            'statusCode': 200,
            'headers': {
                'Content-Type': 'application/json',
                **cors_headers
            },
            'body': json.dumps({
                'instanceId': instance_id,
                'events': events,
                'lastUpdated': datetime.utcnow().isoformat() + 'Z'
            }, default=decimal_default)
        }
        
    except Exception as e:
        print(f"Error querying progress: {str(e)}")  # Add logging
        return {
            'statusCode': 500,
            'headers': {
                'Content-Type': 'application/json',
                **cors_headers
            },
            'body': json.dumps({'error': str(e)})
        }
