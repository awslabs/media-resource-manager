# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

"""Unit tests for the get-session-connections action in
lambda/dcv-session-manager (#139), run by test/dcv-session-manager.test.ts.

After opening a native client link, the console asks whether a client
connected to the session. The owner (or an admin) gets the connection count
of that one session, and only when it runs on that workstation.
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
    'dcv_session_manager_session_connections',
    os.path.join(HERE, '..', '..', 'lambda', 'dcv-session-manager', 'index.py'),
)
mod = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(mod)

SERVER_ID = 'i-1234567890abcdef0'
OTHER_SERVER_ID = 'i-9876543210fedcba9'
USER_ID = 'artist@example.com'
SESSION_ID = '5b0c3a8e-1f2d-4c6b-9a7e-2d4f6a8b0c1e'


class FakeResponse(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class FakeAws:
    def __init__(self, workstation, hub_response=None):
        self.workstation = workstation
        self.hub_response = hub_response
        self.invoked = []

    def resource(self, service, region_name=None):
        fake = self

        class Table:
            def __init__(self, name):
                self.name = name

            def get_item(self, Key):
                return {'Item': fake.workstation} if fake.workstation else {}

        return types.SimpleNamespace(Table=Table)

    def client(self, service, region_name=None):
        fake = self
        if service == 'lambda':
            def invoke(FunctionName, InvocationType, Payload):
                fake.invoked.append(json.loads(Payload))
                return {'Payload': io.BytesIO(json.dumps(fake.hub_response).encode())}
            return types.SimpleNamespace(invoke=invoke)
        return types.SimpleNamespace(get_parameter=lambda Name, WithDecryption=False: {'Parameter': {'Value': 'v'}})


class FakeBroker:
    def __init__(self, sessions):
        self.sessions = sessions
        self.calls = []

    def urlopen(self, request, *args, **kwargs):
        url = request.full_url
        api = url.split(':8443/', 1)[1].split('?')[0]
        self.calls.append((api, json.loads(request.data.decode()) if request.data else None))
        if api.startswith('oauth2/token'):
            return FakeResponse(json.dumps({'access_token': 'tok'}).encode())
        if api == 'describeServers':
            return FakeResponse(json.dumps({'Servers': [
                {'Id': 'srv-1', 'Host': {'Aws': {'EC2InstanceId': SERVER_ID}}},
                {'Id': 'srv-2', 'Host': {'Aws': {'EC2InstanceId': OTHER_SERVER_ID}}},
            ]}).encode())
        if api == 'describeSessions':
            return FakeResponse(json.dumps({'Sessions': self.sessions}).encode())
        raise AssertionError(f'unexpected call {api}')


def event(session_id=SESSION_ID, username=USER_ID, is_admin=False, server_id=SERVER_ID):
    body = {'action': 'get-session-connections', 'serverId': server_id}
    if session_id is not None:
        body['dcvSessionId'] = session_id
    return {
        'httpMethod': 'POST',
        'requestContext': {'authorizer': {'username': username, 'isAdmin': 'true' if is_admin else 'false'}},
        'body': json.dumps(body),
    }


def session(server='srv-1', connections=0, state='READY'):
    return {'Id': SESSION_ID, 'State': state, 'NumOfConnections': connections, 'Server': {'Id': server}}


class SessionConnectionsTest(unittest.TestCase):
    env = {'AWS_REGION': 'us-east-1', 'WORKSTATION_TABLE_NAME': 'mrm-workstations',
           'AWS_ACCOUNT_ID': '123456789012', 'ACRONYM': 'MRM'}

    def call(self, ev, broker, fake=None, workstation_region=None):
        mod._dynamodb_tables.clear()
        fake = fake or FakeAws({'instanceId': SERVER_ID, 'assignedUserId': USER_ID})
        patches = [
            mock.patch.object(mod, 'boto3', fake),
            mock.patch.object(mod, 'safe_urlopen', broker.urlopen),
            mock.patch.object(mod, 'get_workstation_region', return_value=workstation_region),
            mock.patch.dict(os.environ, self.env, clear=True),
            mock.patch('builtins.print'),
        ]
        for p in patches:
            p.start()
        try:
            return mod.lambda_handler(ev, None)
        finally:
            for p in reversed(patches):
                p.stop()

    def test_owner_gets_the_connection_count(self):
        broker = FakeBroker([session(connections=1)])
        response = self.call(event(), broker)
        self.assertEqual(response['statusCode'], 200)
        self.assertEqual(json.loads(response['body']),
                         {'sessionId': SESSION_ID, 'state': 'READY', 'numOfConnections': 1})
        self.assertIn(('describeSessions', {'SessionIds': [SESSION_ID]}), broker.calls)

    def test_no_connection_is_zero(self):
        response = self.call(event(), FakeBroker([{**session(), 'NumOfConnections': None}]))
        self.assertEqual(json.loads(response['body'])['numOfConnections'], 0)

    def test_admin_can_check_any_workstation(self):
        fake = FakeAws({'instanceId': SERVER_ID, 'assignedUserId': 'someone@example.com'})
        response = self.call(event(username='admin@example.com', is_admin=True), FakeBroker([session()]), fake)
        self.assertEqual(response['statusCode'], 200)

    def test_non_owner_is_refused_before_any_broker_call(self):
        fake = FakeAws({'instanceId': SERVER_ID, 'assignedUserId': 'someone@example.com'})
        broker = FakeBroker([session(connections=1)])
        response = self.call(event(), broker, fake)
        self.assertEqual(response['statusCode'], 403)
        self.assertEqual(broker.calls, [])

    def test_session_on_another_workstation_is_not_found(self):
        # The caller owns SERVER_ID, but the session runs on the other server.
        response = self.call(event(), FakeBroker([session(server='srv-2', connections=1)]))
        self.assertEqual(response['statusCode'], 404)
        self.assertNotIn('numOfConnections', response['body'])

    def test_unknown_session_is_not_found(self):
        self.assertEqual(self.call(event(), FakeBroker([]))['statusCode'], 404)

    def test_missing_or_malformed_session_id_is_400(self):
        for bad in (None, '', 'a/b', '../x', 'x' * 129, 7):
            broker = FakeBroker([session()])
            response = self.call(event(session_id=bad), broker)
            self.assertEqual(response['statusCode'], 400, bad)
            self.assertEqual(broker.calls, [])

    def test_hub_workstation_is_routed_to_the_hub(self):
        hub = {'statusCode': 200, 'headers': {}, 'body': json.dumps({'numOfConnections': 0})}
        fake = FakeAws({'instanceId': SERVER_ID, 'assignedUserId': USER_ID}, hub_response=hub)
        broker = FakeBroker([])
        response = self.call(event(), broker, fake, workstation_region='us-west-2')
        self.assertEqual(response, hub)
        self.assertEqual(len(fake.invoked), 1)
        self.assertEqual(broker.calls, [])


class SessionConnectionsHelperTest(unittest.TestCase):
    def test_matches_id_and_server(self):
        self.assertEqual(mod.session_connections([session(connections=2)], {'srv-1'}, SESSION_ID)['numOfConnections'], 2)
        self.assertIsNone(mod.session_connections([session()], {'srv-2'}, SESSION_ID))
        self.assertIsNone(mod.session_connections([{**session(), 'Server': {}}], {'srv-1'}, SESSION_ID))
        self.assertIsNone(mod.session_connections([session()], {'srv-1'}, 'other'))


if __name__ == '__main__':
    unittest.main()
