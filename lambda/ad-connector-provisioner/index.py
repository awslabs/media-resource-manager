# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

"""
CloudFormation Custom Resource that provisions an AWS AD Connector directory
against a customer-supplied Active Directory. Used by IdentityConstruct when
AdMode=connector.

There is no first-class CloudFormation resource for AD Connector (unlike
AWS::DirectoryService::MicrosoftAD for Managed AD), so this Lambda wraps the
ConnectDirectory / DeleteDirectory Directory Service APIs.

Contract:
  ResourceProperties:
    DirectoryName     — FQDN of the customer AD (e.g. "customer.internal")
    NetbiosName       — short NetBIOS name (e.g. "CUSTOMER"), optional
    Size              — "Small" or "Large" (default: "Small")
    Description       — human-readable description on the AWS-side directory
    VpcId             — MRM's VPC ID
    SubnetIds         — list of two subnet IDs (must be in different AZs)
    CustomerDnsIps    — list of 1-4 customer DNS server IPs (the DC IPs)
    ServiceAccountSecretArn — ARN of a Secrets Manager secret containing
                              {"username": "...", "password": "..."} for the
                              customer's AD Connector service account

  Response Data:
    DirectoryId       — the new AWS-side DirectoryId (d-xxxxxxxxxx)
    DnsIpAddresses    — comma-separated list of customer DC IPs (echoed back
                        for downstream consumers that read from the resource
                        return values)

The handler waits synchronously for the directory to transition to Active
before returning SUCCESS. Provisioning typically takes 3-5 minutes; the Lambda
budget is 15 minutes.
"""

import boto3
import json
import time
import urllib.parse
import urllib.request

POLL_INTERVAL_SECONDS = 15
POLL_MAX_ATTEMPTS = 48  # 48 * 15s = 12 minutes; Lambda timeout is 15 minutes


def safe_urlopen(url_or_request, *args, **kwargs):
    """Reject non-HTTPS URLs to guard against file:// and similar schemes."""
    if isinstance(url_or_request, urllib.request.Request):
        url_to_check = url_or_request.full_url
    else:
        url_to_check = url_or_request
    parsed = urllib.parse.urlparse(url_to_check)
    if parsed.scheme not in ['https']:
        raise ValueError(f"Unsafe URL scheme: {parsed.scheme}")
    return urllib.request.urlopen(url_or_request, *args, **kwargs)  # nosec B310 # nosemgrep: dynamic-urllib-use-detected


def send_cfn_response(event, context, status, physical_resource_id, data=None, reason=None):
    """Send response to CloudFormation."""
    response_body = {
        'Status': status,
        'Reason': reason or f'See CloudWatch Log Stream: {context.log_stream_name}',
        'PhysicalResourceId': physical_resource_id,
        'StackId': event['StackId'],
        'RequestId': event['RequestId'],
        'LogicalResourceId': event['LogicalResourceId'],
        'Data': data or {},
    }
    body_bytes = json.dumps(response_body).encode('utf-8')
    req = urllib.request.Request(
        event['ResponseURL'],
        data=body_bytes,
        headers={'Content-Type': 'application/json'},
        method='PUT',
    )
    safe_urlopen(req)


def derive_netbios(domain_name: str) -> str:
    """Fallback NetBIOS derivation from FQDN (first label, uppercased, 15-char max)."""
    first = domain_name.split('.')[0].upper()
    # AD NetBIOS names are max 15 chars, alphanumeric + hyphen only.
    cleaned = ''.join(c for c in first if c.isalnum() or c == '-')
    return cleaned[:15] or 'CUSTOMER'


def read_service_account(secret_arn: str) -> tuple[str, str]:
    """Fetch {username, password} from Secrets Manager."""
    secrets = boto3.client('secretsmanager')
    resp = secrets.get_secret_value(SecretId=secret_arn)
    secret = json.loads(resp['SecretString'])
    if 'username' not in secret or 'password' not in secret:
        raise ValueError(
            f"Secret {secret_arn} must contain both 'username' and 'password' keys"
        )
    return secret['username'], secret['password']


def wait_for_directory_state(ds_client, directory_id: str, target_state: str) -> dict:
    """Poll DescribeDirectories until Stage == target_state or Failed."""
    for attempt in range(POLL_MAX_ATTEMPTS):
        resp = ds_client.describe_directories(DirectoryIds=[directory_id])
        if not resp['DirectoryDescriptions']:
            raise RuntimeError(f"Directory {directory_id} disappeared during provisioning")
        stage = resp['DirectoryDescriptions'][0]['Stage']
        print(f"Directory {directory_id} stage: {stage} (attempt {attempt + 1}/{POLL_MAX_ATTEMPTS})")
        if stage == target_state:
            return resp['DirectoryDescriptions'][0]
        if stage in ('Failed', 'Impaired'):
            reason = resp['DirectoryDescriptions'][0].get('StageReason', 'no reason given')
            raise RuntimeError(f"Directory {directory_id} entered {stage}: {reason}")
        time.sleep(POLL_INTERVAL_SECONDS)
    raise TimeoutError(
        f"Directory {directory_id} did not reach {target_state} within "
        f"{POLL_INTERVAL_SECONDS * POLL_MAX_ATTEMPTS}s"
    )


def create_connector(properties: dict) -> tuple[str, list[str]]:
    """Call ConnectDirectory, wait for Active, return (DirectoryId, DnsIps)."""
    ds_client = boto3.client('ds')

    domain_name = properties['DirectoryName']
    netbios = properties.get('NetbiosName') or derive_netbios(domain_name)
    size = properties.get('Size', 'Small')
    description = properties.get('Description', 'MRM AD Connector')
    vpc_id = properties['VpcId']
    subnet_ids = properties['SubnetIds']
    customer_dns_ips = properties['CustomerDnsIps']
    secret_arn = properties['ServiceAccountSecretArn']

    if isinstance(subnet_ids, str):
        subnet_ids = [s.strip() for s in subnet_ids.split(',') if s.strip()]
    if isinstance(customer_dns_ips, str):
        customer_dns_ips = [s.strip() for s in customer_dns_ips.split(',') if s.strip()]

    if size not in ('Small', 'Large'):
        raise ValueError(f"Size must be 'Small' or 'Large', got {size!r}")
    if len(subnet_ids) != 2:
        raise ValueError(f"Exactly two SubnetIds required, got {len(subnet_ids)}")
    if not (1 <= len(customer_dns_ips) <= 4):
        raise ValueError(f"1-4 CustomerDnsIps required, got {len(customer_dns_ips)}")

    username, password = read_service_account(secret_arn)

    resp = ds_client.connect_directory(
        Name=domain_name,
        ShortName=netbios,
        Password=password,
        Description=description,
        Size=size,
        ConnectSettings={
            'VpcId': vpc_id,
            'SubnetIds': subnet_ids,
            'CustomerDnsIps': customer_dns_ips,
            'CustomerUserName': username,
        },
    )
    directory_id = resp['DirectoryId']
    print(f"ConnectDirectory returned {directory_id}, waiting for Active...")

    wait_for_directory_state(ds_client, directory_id, 'Active')
    return directory_id, customer_dns_ips


def delete_connector(directory_id: str) -> None:
    """Best-effort DeleteDirectory. Does not wait for the delete to complete."""
    ds_client = boto3.client('ds')
    try:
        ds_client.delete_directory(DirectoryId=directory_id)
        print(f"DeleteDirectory called for {directory_id}")
    except ds_client.exceptions.EntityDoesNotExistException:
        print(f"Directory {directory_id} already gone; nothing to delete")
    except Exception as e:
        # Log and swallow — stack teardown should not be blocked by directory
        # deletion errors. Operator can clean up manually via console/API.
        print(f"DeleteDirectory failed for {directory_id}: {e}")


def handler(event, context):
    print(f"Event: {json.dumps({k: v for k, v in event.items() if k != 'ResourceProperties'})}")
    print(f"ResourceProperties: {json.dumps({k: v for k, v in event['ResourceProperties'].items() if k != 'ServiceToken'})}")

    request_type = event['RequestType']
    physical_id = event.get('PhysicalResourceId') or 'ad-connector-not-yet-created'

    try:
        if request_type == 'Create':
            directory_id, dns_ips = create_connector(event['ResourceProperties'])
            send_cfn_response(
                event, context, 'SUCCESS',
                physical_resource_id=directory_id,
                data={
                    'DirectoryId': directory_id,
                    'DnsIpAddresses': ','.join(dns_ips),
                },
            )

        elif request_type == 'Update':
            # ConnectDirectory has no update API for the properties we set
            # (Name/ShortName/CustomerDnsIps are immutable). Treat any relevant
            # change as replacement: create a fresh directory with a new
            # PhysicalResourceId. CFN will then call Delete on the old one.
            old_properties = event.get('OldResourceProperties', {})
            new_properties = event['ResourceProperties']

            immutable = ('DirectoryName', 'NetbiosName', 'VpcId', 'SubnetIds',
                         'CustomerDnsIps', 'ServiceAccountSecretArn')
            replacement_needed = any(
                old_properties.get(k) != new_properties.get(k) for k in immutable
            )

            if replacement_needed:
                directory_id, dns_ips = create_connector(new_properties)
                send_cfn_response(
                    event, context, 'SUCCESS',
                    physical_resource_id=directory_id,
                    data={
                        'DirectoryId': directory_id,
                        'DnsIpAddresses': ','.join(dns_ips),
                    },
                )
            else:
                # No replacement needed (only Size/Description changed, and we
                # don't currently propagate those). No-op.
                send_cfn_response(
                    event, context, 'SUCCESS',
                    physical_resource_id=physical_id,
                    data={'DirectoryId': physical_id},
                )

        elif request_type == 'Delete':
            # Only attempt DeleteDirectory if we actually have a real ID.
            if physical_id and physical_id.startswith('d-'):
                delete_connector(physical_id)
            send_cfn_response(
                event, context, 'SUCCESS',
                physical_resource_id=physical_id,
            )

        else:
            raise ValueError(f"Unknown RequestType: {request_type}")

    except Exception as e:
        print(f"Error handling {request_type}: {e}")
        send_cfn_response(
            event, context, 'FAILED',
            physical_resource_id=physical_id,
            reason=str(e),
        )
