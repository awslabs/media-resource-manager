# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

"""
DCV Session Manager Broker Health Check

Proactive health probe that runs on a schedule to detect an unresponsive
broker. If the broker fails to respond to a health check, this function:
1. Restarts the broker service via SSM
2. Waits for it to come back
3. Refreshes the DCV session manager Lambda ENIs by bumping its description
4. Publishes an SNS notification (if configured)
"""

import json
import os
import ssl
import time
import urllib.request
import urllib.parse
import urllib.error
import boto3


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
    pascal_case_name = os.environ.get('PASCAL_CASE_NAME', 'MediaResourceManager')
    session_manager_lambda = os.environ.get('SESSION_MANAGER_LAMBDA_NAME', '')
    sns_topic_arn = os.environ.get('SNS_TOPIC_ARN', '')
    health_timeout = int(os.environ.get('HEALTH_CHECK_TIMEOUT_SECONDS', '10'))
    max_wait_after_restart = int(os.environ.get('MAX_WAIT_AFTER_RESTART_SECONDS', '60'))

    ssm = boto3.client('ssm')
    region = os.environ.get('AWS_REGION', 'us-east-1')

    # Get the Session Manager NLB endpoint
    try:
        endpoint = ssm.get_parameter(
            Name=f'/{pascal_case_name}/DCV/SessionManager/Endpoint'
        )['Parameter']['Value']
    except Exception as e:
        print(f"ERROR: Could not get Session Manager endpoint from SSM: {e}")
        return {'statusCode': 500, 'body': f'SSM parameter error: {e}'}

    health_url = f"https://{endpoint}:8443/health"
    print(f"Checking broker health at: {health_url}")

    # Create SSL context (broker uses self-signed cert)
    ssl_context = ssl.create_default_context()
    ssl_context.check_hostname = False
    ssl_context.verify_mode = ssl.CERT_NONE

    # Health check
    healthy = False
    try:
        req = urllib.request.Request(health_url, method='GET')
        response = safe_urlopen(  # nosec B310
            req, timeout=health_timeout, context=ssl_context
        )
        status = response.getcode()
        if status == 200:
            healthy = True
            print(f"Broker is healthy (HTTP {status})")
        else:
            print(f"Broker returned unexpected status: {status}")
    except urllib.error.URLError as e:
        print(f"Broker health check failed (URLError): {e}")
    except Exception as e:
        print(f"Broker health check failed: {e}")

    if healthy:
        return {
            'statusCode': 200,
            'body': json.dumps({'status': 'healthy', 'endpoint': endpoint})
        }

    # Broker is unhealthy — restart it
    print("Broker is UNHEALTHY — initiating restart...")

    # Find the Session Manager instance(s) via ASG
    autoscaling = boto3.client('autoscaling')

    try:
        # Find the Session Manager ASG
        asgs = autoscaling.describe_auto_scaling_groups()
        sm_asg = None
        for asg in asgs['AutoScalingGroups']:
            if 'SessionManager' in asg['AutoScalingGroupName']:
                sm_asg = asg
                break

        if not sm_asg:
            print("ERROR: Could not find Session Manager ASG")
            return {'statusCode': 500, 'body': 'Session Manager ASG not found'}

        # Get all InService instance IDs
        instance_ids = [
            i['InstanceId'] for i in sm_asg['Instances']
            if i['LifecycleState'] == 'InService'
        ]
        if not instance_ids:
            print("ERROR: No InService instances in Session Manager ASG")
            return {'statusCode': 500, 'body': 'No healthy instances in ASG'}

        print(f"Session Manager instances: {instance_ids}")

    except Exception as e:
        print(f"ERROR finding Session Manager instances: {e}")
        return {'statusCode': 500, 'body': f'ASG lookup error: {e}'}

    # Restart the broker on ALL instances via SSM
    try:
        ssm_client = boto3.client('ssm')
        response = ssm_client.send_command(
            InstanceIds=instance_ids,
            DocumentName='AWS-RunShellScript',
            Parameters={
                'commands': [
                    'sudo systemctl restart dcv-session-manager-broker',
                    'echo "Broker restart initiated at $(date -u)"'
                ]
            },
            TimeoutSeconds=30,
            Comment='Auto-restart: broker health check failed'
        )
        command_id = response['Command']['CommandId']
        print(f"Restart command sent to {len(instance_ids)} instance(s): {command_id}")

    except Exception as e:
        print(f"ERROR sending restart command: {e}")
        return {'statusCode': 500, 'body': f'SSM command error: {e}'}

    # Wait for broker to come back
    print(f"Waiting for broker to recover (max {max_wait_after_restart}s)...")
    start_time = time.time()
    broker_recovered = False

    while time.time() - start_time < max_wait_after_restart:
        time.sleep(10)
        try:
            req = urllib.request.Request(health_url, method='GET')
            response = safe_urlopen(  # nosec B310
                req, timeout=health_timeout, context=ssl_context
            )
            if response.getcode() == 200:
                broker_recovered = True
                elapsed = int(time.time() - start_time)
                print(f"Broker recovered after {elapsed}s")
                break
        except Exception:
            elapsed = int(time.time() - start_time)
            print(f"Broker still starting... ({elapsed}s elapsed)")

    if not broker_recovered:
        print("WARNING: Broker did not recover within timeout")

    # Refresh the DCV session manager Lambda ENIs
    if session_manager_lambda:
        try:
            lambda_client = boto3.client('lambda')
            timestamp = int(time.time())
            lambda_client.update_function_configuration(
                FunctionName=session_manager_lambda,
                Description=f'Recycle stale instances {timestamp}'
            )
            print(f"Refreshed Lambda ENIs for {session_manager_lambda}")
        except Exception as e:
            print(f"WARNING: Failed to refresh Lambda ENIs: {e}")

    # Send SNS notification
    if sns_topic_arn:
        try:
            sns = boto3.client('sns')
            status_msg = "recovered" if broker_recovered else "FAILED TO RECOVER"
            sns.publish(
                TopicArn=sns_topic_arn,
                Subject=f'DCV Broker Auto-Restart ({status_msg})',
                Message=(
                    f"The DCV Session Manager broker was detected as unresponsive "
                    f"and has been automatically restarted.\n\n"
                    f"Instances: {', '.join(instance_ids)}\n"
                    f"Region: {region}\n"
                    f"Recovery status: {status_msg}\n"
                    f"Lambda ENIs refreshed: {bool(session_manager_lambda)}\n"
                    f"Timestamp: {time.strftime('%Y-%m-%d %H:%M:%S UTC', time.gmtime())}"
                )
            )
            print("SNS notification sent")
        except Exception as e:
            print(f"WARNING: Failed to send SNS notification: {e}")

    return {
        'statusCode': 200 if broker_recovered else 500,
        'body': json.dumps({
            'status': 'recovered' if broker_recovered else 'restart_failed',
            'instances': instance_ids,
            'endpoint': endpoint
        })
    }
