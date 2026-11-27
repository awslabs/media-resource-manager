# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

"""Unit tests for the native client protocol in lambda/dcv-session-manager
create-session (#138), run by test/dcv-session-manager.test.ts.

A workstation override or the caller's user override wins over Settings >
Native client protocol; when both are set and disagree, TCP wins. With
neither set the Settings value applies, then QUIC. Only the primary Region's
copy resolves it; for a hub workstation it adds the field to the hub's answer.
"""

import importlib.util
import io
import json
import os
import sys
import types
import unittest
from unittest import mock

# The Lambda imports boto3 at module load; these tests stub every AWS call.
sys.modules.setdefault('boto3', types.ModuleType('boto3'))

HERE = os.path.dirname(os.path.abspath(__file__))
SPEC = importlib.util.spec_from_file_location(
    'dcv_session_manager_native_transport',
    os.path.join(HERE, '..', '..', 'lambda', 'dcv-session-manager', 'index.py'),
)
mod = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(mod)

SERVER_ID = 'i-1234567890abcdef0'
USER_ID = 'artist@example.com'
SETTING = '/MediaResourceManager/DCV/NativeClientTransport'


class FakeResponse(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class FakeAws:
    """boto3 stand-in holding the workstation and user tables and SSM."""

    def __init__(self, workstation=None, user=None, setting=None, hub_response=None):
        self.items = {
            'mrm-workstations': {SERVER_ID: workstation} if workstation is not None else {},
            'mrm-users': {USER_ID: user} if user is not None else {},
        }
        self.setting = setting
        self.hub_response = hub_response
        self.invoked = []

    def resource(self, service, region_name=None):
        fake = self

        class Table:
            def __init__(self, name):
                self.name = name

            def get_item(self, Key):
                item = fake.items[self.name].get(next(iter(Key.values())))
                return {'Item': item} if item else {}

        return types.SimpleNamespace(Table=Table)

    def client(self, service, region_name=None):
        fake = self
        if service == 'lambda':
            def invoke(FunctionName, InvocationType, Payload):
                fake.invoked.append(FunctionName)
                return {'Payload': io.BytesIO(json.dumps(fake.hub_response).encode())}
            return types.SimpleNamespace(invoke=invoke)

        def get_parameter(Name, WithDecryption=False):
            if Name == SETTING:
                if fake.setting is None:
                    raise Exception('ParameterNotFound')
                return {'Parameter': {'Value': fake.setting}}
            if Name.endswith('/ConnectionGateway/Endpoint'):
                return {'Parameter': {'Value': 'gw.example.com'}}
            if Name.endswith('/BrowserGatewayUrl'):
                return {'Parameter': {'Value': 'https://d111111abcdef8.cloudfront.net'}}
            return {'Parameter': {'Value': 'value'}}
        return types.SimpleNamespace(get_parameter=get_parameter)


def broker_urlopen(request, *args, **kwargs):
    url = request.full_url if hasattr(request, 'full_url') else request
    api = url.split(':8443/', 1)[1].split('?')[0]
    if api.startswith('oauth2/token'):
        return FakeResponse(json.dumps({'access_token': 'tok'}).encode())
    if api == 'describeServers':
        return FakeResponse(json.dumps({'Servers': [{
            'Id': 'srv-1', 'Availability': 'AVAILABLE', 'ConsoleSessionCount': 1,
            'Host': {'Aws': {'EC2InstanceId': SERVER_ID}}}]}).encode())
    if api == 'describeSessions':
        return FakeResponse(json.dumps({'Sessions': [{
            'Id': 'sess-1', 'State': 'READY', 'Owner': 'ubuntu', 'Server': {'Id': 'srv-1'}}]}).encode())
    if api.startswith('sessionConnectionData/'):
        return FakeResponse(json.dumps({'ConnectionToken': 'conn-token'}).encode())
    raise AssertionError(f'unexpected call {api}')


def connect_event(username=USER_ID, is_admin=False):
    return {
        'httpMethod': 'POST',
        'requestContext': {'authorizer': {'username': username, 'isAdmin': 'true' if is_admin else 'false'}},
        'body': json.dumps({'action': 'create-session', 'serverId': SERVER_ID, 'sessionName': 'Ana Li'}),
    }


# The design table in PR #164: (global, workstation override, user override) -> result.
SCENARIOS = [
    ('quic', None, None, 'quic'),                  # global QUIC, no overrides
    ('quic', 'websocket', None, 'websocket'),      # global QUIC + workstation TCP
    ('websocket', 'quic', None, 'quic'),           # one override wins over global, either way
    ('websocket', None, 'quic', 'quic'),
    ('quic', 'quic', 'websocket', 'websocket'),    # user TCP + workstation QUIC
    ('quic', 'websocket', 'quic', 'websocket'),    # user QUIC + workstation TCP
    ('websocket', 'quic', 'quic', 'quic'),         # user QUIC + workstation QUIC, global TCP
    ('quic', 'websocket', 'websocket', 'websocket'),
]


class ResolveTest(unittest.TestCase):
    def test_design_table(self):
        for global_setting, workstation, user, expected in SCENARIOS:
            with self.subTest(global_setting=global_setting, workstation=workstation, user=user):
                self.assertEqual(
                    mod.resolve_native_client_transport(workstation, user, global_setting), expected)

    def test_disagreeing_overrides_are_tcp_whatever_the_global_setting(self):
        for global_setting in ('quic', 'websocket', None):
            self.assertEqual(mod.resolve_native_client_transport('quic', 'websocket', global_setting), 'websocket')
            self.assertEqual(mod.resolve_native_client_transport('websocket', 'quic', global_setting), 'websocket')

    def test_user_override_wins_over_the_global_setting(self):
        self.assertEqual(mod.resolve_native_client_transport(None, 'websocket', 'quic'), 'websocket')
        self.assertEqual(mod.resolve_native_client_transport(None, 'quic', 'websocket'), 'quic')

    def test_global_setting_then_quic(self):
        self.assertEqual(mod.resolve_native_client_transport(None, None, 'websocket'), 'websocket')
        self.assertEqual(mod.resolve_native_client_transport(None, None, None), 'quic')

    def test_unknown_values_count_as_not_set(self):
        self.assertEqual(mod.resolve_native_client_transport('tcp', '', 'websocket'), 'websocket')
        self.assertEqual(mod.resolve_native_client_transport({'S': 'websocket'}, 'TCP', 'udp'), 'quic')


class CreateSessionTest(unittest.TestCase):
    env = {'AWS_REGION': 'us-east-1', 'WORKSTATION_TABLE_NAME': 'mrm-workstations',
           'USER_TABLE_NAME': 'mrm-users', 'AWS_ACCOUNT_ID': '123456789012', 'ACRONYM': 'MRM'}

    def connect(self, fake, workstation_region=None, env=None, **event_args):
        mod._dynamodb_tables.clear()
        patches = [
            mock.patch.object(mod, 'boto3', fake),
            mock.patch.object(mod, 'safe_urlopen', broker_urlopen),
            mock.patch.object(mod, 'get_workstation_region', return_value=workstation_region),
            mock.patch.object(mod, 'get_default_session_owner', return_value=('ubuntu', workstation_region)),
            mock.patch.object(mod, 'get_regional_dcv_endpoints', return_value=None),
            mock.patch.dict(os.environ, env or self.env, clear=True),
            mock.patch('builtins.print'),
        ]
        for p in patches:
            p.start()
        try:
            return mod.lambda_handler(connect_event(**event_args), None)
        finally:
            for p in reversed(patches):
                p.stop()

    def transport(self, response):
        self.assertEqual(response['statusCode'], 200)
        return json.loads(response['body'])['nativeClientTransport']

    def owned(self, **extra):
        return {'instanceId': SERVER_ID, 'assignedUserId': USER_ID, **extra}

    def test_no_override_and_no_setting_is_quic(self):
        self.assertEqual(self.transport(self.connect(FakeAws(workstation=self.owned()))), 'quic')

    def test_no_override_follows_the_global_setting(self):
        fake = FakeAws(workstation=self.owned(), setting='websocket')
        self.assertEqual(self.transport(self.connect(fake)), 'websocket')

    def test_user_override(self):
        fake = FakeAws(workstation=self.owned(), user={'userId': USER_ID, 'nativeClientTransport': 'websocket'},
                       setting='quic')
        self.assertEqual(self.transport(self.connect(fake)), 'websocket')

    def test_design_table_through_create_session(self):
        for global_setting, workstation, user, expected in SCENARIOS:
            with self.subTest(global_setting=global_setting, workstation=workstation, user=user):
                ws_extra = {'nativeClientTransport': workstation} if workstation else {}
                user_item = {'userId': USER_ID, 'nativeClientTransport': user} if user else None
                fake = FakeAws(workstation=self.owned(**ws_extra), user=user_item, setting=global_setting)
                self.assertEqual(self.transport(self.connect(fake)), expected)

    def test_workstation_override_holds_when_global_changes_and_changes_back(self):
        # Global TCP, then back to QUIC: the workstation's TCP override stays TCP.
        fake = FakeAws(workstation=self.owned(nativeClientTransport='websocket'), setting='websocket')
        self.assertEqual(self.transport(self.connect(fake)), 'websocket')
        fake.setting = 'quic'
        self.assertEqual(self.transport(self.connect(fake)), 'websocket')

    def test_user_tcp_beats_workstation_quic(self):
        fake = FakeAws(workstation=self.owned(nativeClientTransport='quic'),
                       user={'userId': USER_ID, 'nativeClientTransport': 'websocket'}, setting='quic')
        self.assertEqual(self.transport(self.connect(fake)), 'websocket')

    def test_workstation_tcp_beats_user_quic(self):
        fake = FakeAws(workstation=self.owned(nativeClientTransport='websocket'),
                       user={'userId': USER_ID, 'nativeClientTransport': 'quic'}, setting='quic')
        self.assertEqual(self.transport(self.connect(fake)), 'websocket')

    def test_agreeing_quic_overrides_beat_global_tcp(self):
        fake = FakeAws(workstation=self.owned(nativeClientTransport='quic'),
                       user={'userId': USER_ID, 'nativeClientTransport': 'quic'}, setting='websocket')
        self.assertEqual(self.transport(self.connect(fake)), 'quic')

    def test_the_caller_override_is_used_not_the_assignee(self):
        # An admin connecting to someone else's workstation gets the admin's own override.
        fake = FakeAws(workstation=self.owned(), user={'userId': USER_ID, 'nativeClientTransport': 'websocket'})
        self.assertEqual(self.transport(self.connect(fake, username='admin@example.com', is_admin=True)), 'quic')

    def test_connection_urls_are_unchanged(self):
        response = self.connect(FakeAws(workstation=self.owned(nativeClientTransport='websocket')))
        body = json.loads(response['body'])
        self.assertEqual(body['connectionUrl'], 'https://gw.example.com:8443/?authToken=conn-token#sess-1')
        self.assertEqual(body['quicConnectionUrl'], 'https://gw.example.com:8444/?authToken=conn-token#sess-1')

    def test_hub_workstation_gets_the_field_from_the_primary(self):
        hub_body = {'sessionId': 'sess-9', 'connectionUrl': 'https://hub-gw:8443/?authToken=t#sess-9',
                    'quicConnectionUrl': 'https://hub-gw:8444/?authToken=t#sess-9'}
        fake = FakeAws(workstation=self.owned(region='us-west-2'), setting='websocket',
                       hub_response={'statusCode': 200, 'headers': {}, 'body': json.dumps(hub_body)})
        response = self.connect(fake, workstation_region='us-west-2')
        self.assertEqual(fake.invoked, ['arn:aws:lambda:us-west-2:123456789012:function:mrm-regional-dcv-session-manager'])
        body = json.loads(response['body'])
        self.assertEqual(body['nativeClientTransport'], 'websocket')
        self.assertEqual(body['connectionUrl'], hub_body['connectionUrl'])

    def test_hub_error_is_passed_through_unchanged(self):
        hub = {'statusCode': 409, 'headers': {}, 'body': json.dumps({'status': 'session-starting'})}
        fake = FakeAws(workstation=self.owned(region='us-west-2'), hub_response=hub)
        self.assertEqual(self.connect(fake, workstation_region='us-west-2'), hub)

    def test_hub_copy_does_not_resolve(self):
        # The hub copy can't read the primary's setting; the primary adds the field.
        env = {**self.env, 'AWS_REGION': 'us-west-2', 'PRIMARY_REGION': 'us-east-1'}
        fake = FakeAws(workstation=self.owned(nativeClientTransport='websocket'))
        response = self.connect(fake, env=env)
        self.assertEqual(response['statusCode'], 200)
        self.assertNotIn('nativeClientTransport', json.loads(response['body']))

    def test_a_failed_lookup_does_not_fail_the_connect(self):
        fake = FakeAws(workstation=self.owned(), setting='websocket')
        fake.items['mrm-users'] = None  # the user table read raises
        self.assertEqual(self.transport(self.connect(fake)), 'websocket')

    def test_non_owner_is_still_refused(self):
        fake = FakeAws(workstation={'instanceId': SERVER_ID, 'assignedUserId': 'someone@example.com'})
        self.assertEqual(self.connect(fake)['statusCode'], 403)


if __name__ == '__main__':
    unittest.main()
