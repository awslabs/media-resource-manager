# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

"""Console session check for new Windows and Linux workstations.

The Windows creation workflow reboots the instance at the end so the new host
name takes effect. After the reboot the DCV server registers with the Session
Manager again under a new server ID, and the first console session can take
minutes to reach READY. Until it does, Connect fails (HTTP 400/504).

On Linux the DCV server can register while the desktop (GDM/Xorg) never
starts, so a console session is never created and Connect fails. The Linux
workflow runs this check after the DCV server registers and fails the
creation if no session becomes READY.

SESSION_PLATFORM selects the session owner: 'Windows' (default) uses
Administrator; 'Linux' uses the distro's default user, chosen the same way
dcv-session-manager chooses it at Connect.

Each invocation is one poll step of a Step Functions loop:
  * a READY console session for the default owner exists -> ready
  * a session is still being created -> wait
  * no session -> create one, then wait

The READY session is left in place on purpose: dcv-session-manager reuses an
existing READY session, so the first Connect returns at once.

Workstations in a satellite region are skipped: this function runs in the main
region and cannot reach a satellite region's Session Manager.
"""

import base64
import json
import os
import ssl
import urllib.parse
import urllib.request

SESSION_OWNER = 'Administrator'
SESSION_NAME = 'Console'
TEST_SESSION_PREFIX = 'test-readiness-'
PENDING_STATES = {'CREATING'}
RHEL_FAMILY = ('rocky', 'rhel', 'centos')


def linux_session_owner(item, image=None):
    """Default Linux session owner for a workstation record and its AMI.

    Same rules, in the same order, as get_default_session_owner in
    lambda/dcv-session-manager/index.py, so Connect finds the session this
    check creates. Keep the two in step.
    """
    distro = str(item.get('linuxDistro', '')).lower()
    if distro in RHEL_FAMILY:
        return 'rocky'
    if distro == 'ubuntu':
        return 'ubuntu'
    name = str(item.get('workstationName', '')).lower()
    if any(d in name for d in RHEL_FAMILY):
        return 'rocky'
    if image:
        ami_name = str(image.get('Name', '')).lower()
        ami_desc = str(image.get('Description', '')).lower()
        if 'rocky' in ami_name or 'rocky' in ami_desc or 'rhel' in ami_name or 'centos' in ami_name:
            return 'rocky'
    return 'ubuntu'


def _session_owner(event):
    """Owner of the console session to wait for, looked up once and then carried in the event."""
    if event.get('consoleSessionOwner'):
        return event['consoleSessionOwner']
    if os.environ.get('SESSION_PLATFORM', 'Windows') != 'Linux':
        return SESSION_OWNER
    import boto3
    table = boto3.resource('dynamodb').Table(os.environ['WORKSTATION_TABLE_NAME'])
    item = table.get_item(Key={'instanceId': event['instanceId']}).get('Item', {})
    image = None
    if not item.get('linuxDistro') and item.get('amiId'):
        images = boto3.client('ec2').describe_images(ImageIds=[item['amiId']]).get('Images', [])
        image = images[0] if images else None
    return linux_session_owner(item, image)


def safe_urlopen(url_or_request, *args, **kwargs):
    """Open HTTPS URLs only."""
    url = url_or_request.full_url if isinstance(url_or_request, urllib.request.Request) else url_or_request
    if urllib.parse.urlparse(url).scheme != 'https':
        raise ValueError('Unsafe URL scheme')
    return urllib.request.urlopen(url_or_request, *args, **kwargs)  # nosec B310 # nosemgrep: dynamic-urllib-use-detected


def matching_servers(servers, instance_id):
    """All broker server entries for the instance (a stale pre-reboot entry may still be listed)."""
    return [s for s in servers if s.get('Host', {}).get('Aws', {}).get('EC2InstanceId') == instance_id]


def evaluate(servers, sessions, instance_id, known_session_id=None, owner=SESSION_OWNER):
    """Decide the next step from describeServers and describeSessions output.

    Returns (action, session_id), action one of 'ready', 'wait', 'create'.
    """
    servers_for_instance = matching_servers(servers, instance_id)
    if not servers_for_instance:
        return 'wait', known_session_id

    server_ids = {s.get('Id') for s in servers_for_instance}
    # dcv-session-manager only reuses a READY session when the server also
    # reports it, so wait for the server's count to catch up.
    server_session_count = max(
        s.get('ConsoleSessionCount', 0) + s.get('VirtualSessionCount', 0) for s in servers_for_instance
    )

    candidates = []
    for session in sessions:
        if session.get('Name', '').startswith(TEST_SESSION_PREFIX) or session.get('Owner') != owner:
            continue
        # A session we created may not be placed on a server yet, so match it by ID too.
        if session.get('Id') == known_session_id or session.get('Server', {}).get('Id') in server_ids:
            candidates.append(session)

    states = {str(s.get('State', '')).upper(): s.get('Id') for s in candidates}
    if 'READY' in states:
        return ('ready' if server_session_count > 0 else 'wait'), states['READY']
    for state in PENDING_STATES:
        if state in states:
            return 'wait', states[state]
    return 'create', None


def _endpoints():
    import boto3  # imported here so the decision logic can be unit tested without boto3
    prefix = f"/{os.environ.get('PASCAL_CASE_NAME', 'MediaResourceManager')}/DCV/SessionManager"
    ssm = boto3.client('ssm')
    return (
        ssm.get_parameter(Name=f'{prefix}/Endpoint')['Parameter']['Value'],
        ssm.get_parameter(Name=f'{prefix}/ClientId')['Parameter']['Value'],
        ssm.get_parameter(Name=f'{prefix}/ClientPassword', WithDecryption=True)['Parameter']['Value'],
    )


def _broker():
    """Return a function that calls a Session Manager API and returns its JSON."""
    host, client_id, client_password = _endpoints()
    base_url = f'https://{host}:8443'
    # The broker uses a self-signed certificate, as in the other DCV Lambdas.
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE

    basic = base64.b64encode(f'{client_id}:{client_password}'.encode()).decode()
    token_request = urllib.request.Request(
        f'{base_url}/oauth2/token?grant_type=client_credentials',
        method='POST',
        headers={'Authorization': f'Basic {basic}'},
    )
    with safe_urlopen(token_request, context=ctx, timeout=10) as response:
        access_token = json.loads(response.read().decode())['access_token']

    def call(api, body):
        request = urllib.request.Request(
            f'{base_url}/{api}',
            data=json.dumps(body).encode(),
            headers={'Authorization': f'Bearer {access_token}', 'Content-Type': 'application/json'},
            method='POST',
        )
        with safe_urlopen(request, context=ctx, timeout=10) as response:
            return json.loads(response.read().decode())

    return call


def _list(call, api, key):
    items, body = [], {}
    while True:
        page = call(api, body)
        items.extend(page.get(key, []))
        if not page.get('NextToken'):
            return items
        body = {'NextToken': page['NextToken']}


def lambda_handler(event, context):
    instance_id = event.get('instanceId')
    checks = int(event.get('consoleSessionChecks', 0)) + 1
    result = {**event, 'consoleSessionChecks': checks, 'consoleSessionReady': False}

    region = event.get('region')
    if region and region != os.environ.get('AWS_REGION'):
        print(f'{instance_id} is in satellite region {region}; console session check skipped')
        return {**result, 'consoleSessionReady': True, 'consoleSessionCheckSkipped': True}

    try:
        owner = _session_owner(event)
        result['consoleSessionOwner'] = owner
        call = _broker()
        servers = _list(call, 'describeServers', 'Servers')
        sessions = _list(call, 'describeSessions', 'Sessions')
        action, session_id = evaluate(servers, sessions, instance_id, event.get('consoleSessionId'), owner)
        print(f'Check {checks} for {instance_id}: {len(matching_servers(servers, instance_id))} server entries, '
              f'owner={owner}, action={action}, session={session_id}')

        if action == 'create':
            created = call('createSessions', [{
                'Name': SESSION_NAME,
                'Owner': owner,
                'Type': 'CONSOLE',
                'Requirements': f"server:Host.Aws.Ec2InstanceId = '{instance_id}'",
            }])
            if created.get('SuccessfulList'):
                session_id = created['SuccessfulList'][0].get('Id')
                print(f'Created console session {session_id}')
            else:
                reason = (created.get('UnsuccessfulList') or [{}])[0].get('FailureReason', 'unknown')
                print(f'Console session not created yet: {reason}')

        if session_id:
            result['consoleSessionId'] = session_id
        result['consoleSessionReady'] = action == 'ready'
    except Exception as error:  # the state machine retries on the next check
        print(f'Console session check failed for {instance_id}: {type(error).__name__}: {error}')

    return result
