# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

"""Unit tests for the create-session wait and the console session check calls in
lambda/dcv-session-manager (run by test/dcv-session-manager.test.ts).

API Gateway ends a request after 29 seconds, so create-session must stop
waiting for a new console session well before that and answer 409
session-starting. A hub's copy also runs Session Manager calls for the primary
Region's console-session-ready Lambda.
"""

import importlib.util
import io
import json
import os
import sys
import types
import unittest
import urllib.error
from unittest import mock

# The Lambda imports boto3 at module load; these tests stub every AWS call.
sys.modules.setdefault('boto3', types.ModuleType('boto3'))

HERE = os.path.dirname(os.path.abspath(__file__))
SPEC = importlib.util.spec_from_file_location(
    'dcv_session_manager_session_wait',
    os.path.join(HERE, '..', '..', 'lambda', 'dcv-session-manager', 'index.py'),
)
mod = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(mod)

SERVER_ID = 'i-1234567890abcdef0'
SERVER = {'Id': 'srv-1', 'Availability': 'AVAILABLE', 'ConsoleSessionCount': 0,
          'Host': {'Aws': {'EC2InstanceId': SERVER_ID}}}


class Clock:
    """Fake time: sleep advances monotonic, so the wait budget runs instantly."""

    def __init__(self):
        self.now = 1000.0

    def monotonic(self):
        return self.now

    def sleep(self, seconds):
        self.now += seconds


class FakeResponse(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class FakeBroker:
    """Answers the Session Manager URLs the handler calls."""

    def __init__(self, sessions=(), ready_after=None, clock=None):
        self.sessions = list(sessions)
        self.ready_after = ready_after  # seconds of fake time; None = never READY
        self.clock = clock
        self.calls = []
        self.started = clock.now if clock else 0

    def urlopen(self, request, *args, **kwargs):
        url = request.full_url if hasattr(request, 'full_url') else request
        api = url.split(':8443/', 1)[1].split('?')[0]
        self.calls.append(api.split('/')[0])
        if api.startswith('oauth2/token'):
            return FakeResponse(json.dumps({'access_token': 'tok'}).encode())
        if api == 'describeServers':
            return FakeResponse(json.dumps({'Servers': [SERVER]}).encode())
        if api == 'describeSessions':
            return FakeResponse(json.dumps({'Sessions': self.sessions}).encode())
        if api == 'createSessions':
            return FakeResponse(json.dumps({'SuccessfulList': [{'Id': 'new-session'}]}).encode())
        if api.startswith('sessionConnectionData/'):
            if self.ready_after is not None and self.clock.now - self.started >= self.ready_after:
                return FakeResponse(json.dumps({'ConnectionToken': 'conn-token'}).encode())
            body = b"Cannot connect to the session as it's neither in READY nor UNKNOWN state"
            raise urllib.error.HTTPError(url, 400, 'Bad Request', {}, io.BytesIO(body))
        raise AssertionError(f'unexpected call {api}')


def fake_ssm():
    values = {
        'ClientId': 'client-id', 'ClientPassword': 'secret', 'Endpoint': 'sm.example.com',
    }

    def get_parameter(Name, WithDecryption=False):
        if Name.endswith('/ConnectionGateway/Endpoint'):
            return {'Parameter': {'Value': 'gw.example.com'}}
        if Name.endswith('/BrowserGatewayUrl'):
            return {'Parameter': {'Value': 'https://d111111abcdef8.cloudfront.net'}}
        return {'Parameter': {'Value': values[Name.rsplit('/', 1)[1]]}}

    return types.SimpleNamespace(get_parameter=get_parameter)


def connect_event():
    return {
        'httpMethod': 'POST',
        'requestContext': {'authorizer': {'username': 'admin', 'isAdmin': 'true'}},
        'body': json.dumps({'action': 'create-session', 'serverId': SERVER_ID, 'sessionName': 'Ana Li'}),
    }


class SessionWaitTest(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        patches = [
            mock.patch('time.monotonic', self.clock.monotonic),
            mock.patch('time.sleep', self.clock.sleep),
            mock.patch.object(mod, 'boto3', types.SimpleNamespace(client=lambda *_a, **_k: fake_ssm())),
            mock.patch.object(mod, 'get_workstation_region', return_value=None),
            mock.patch.object(mod, 'get_default_session_owner', return_value=('ubuntu', None)),
            mock.patch.dict(os.environ, {'AWS_REGION': 'us-west-2'}),
            mock.patch('builtins.print'),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def run_connect(self, broker):
        with mock.patch.object(mod, 'safe_urlopen', broker.urlopen):
            return mod.lambda_handler(connect_event(), None)

    def test_returns_session_starting_before_the_api_gateway_limit(self):
        broker = FakeBroker(clock=self.clock)
        response = self.run_connect(broker)
        self.assertEqual(response['statusCode'], 409)
        body = json.loads(response['body'])
        self.assertEqual(body['status'], 'session-starting')
        self.assertEqual(body['sessionId'], 'new-session')
        self.assertGreater(body['retryAfterSeconds'], 0)
        self.assertEqual(response['headers']['Access-Control-Allow-Origin'], '*')
        # Time spent waiting, well under API Gateway's 29 s with room for the regional hop.
        self.assertLessEqual(self.clock.now - 1000.0, mod.SESSION_WAIT_BUDGET_SECONDS)

    def test_returns_the_connection_when_the_session_becomes_ready_in_time(self):
        broker = FakeBroker(ready_after=6, clock=self.clock)
        response = self.run_connect(broker)
        self.assertEqual(response['statusCode'], 200)
        self.assertEqual(json.loads(response['body'])['sessionId'], 'new-session')

    def test_retry_waits_for_the_creating_session_instead_of_creating_another(self):
        creating = {'Id': 'creating-1', 'State': 'CREATING', 'Owner': 'ubuntu', 'Name': 'Ana Li',
                    'Server': {'Id': 'srv-1'}}
        broker = FakeBroker(sessions=[creating], ready_after=0, clock=self.clock)
        response = self.run_connect(broker)
        self.assertEqual(response['statusCode'], 200)
        self.assertEqual(json.loads(response['body'])['sessionId'], 'creating-1')
        self.assertNotIn('createSessions', broker.calls)

    def test_creating_session_of_another_owner_or_server_is_not_reused(self):
        others = [
            {'Id': 'x1', 'State': 'CREATING', 'Owner': 'rocky', 'Server': {'Id': 'srv-1'}},
            {'Id': 'x2', 'State': 'CREATING', 'Owner': 'ubuntu', 'Server': {'Id': 'srv-other'}},
        ]
        broker = FakeBroker(sessions=others, ready_after=0, clock=self.clock)
        response = self.run_connect(broker)
        self.assertEqual(json.loads(response['body'])['sessionId'], 'new-session')
        self.assertIn('createSessions', broker.calls)


class ConsoleSessionBrokerCallTest(unittest.TestCase):
    HUB_ENV = {'AWS_REGION': 'us-west-2', 'PRIMARY_REGION': 'us-east-1'}

    def setUp(self):
        self.broker = FakeBroker()
        patches = [
            mock.patch.object(mod, 'boto3', types.SimpleNamespace(client=lambda *_a, **_k: fake_ssm())),
            mock.patch.object(mod, 'safe_urlopen', self.broker.urlopen),
            mock.patch('builtins.print'),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def call(self, api, body, env=None, **extra):
        event = {'consoleSessionBrokerCall': {'api': api, 'body': body}, **extra}
        with mock.patch.dict(os.environ, env or self.HUB_ENV):
            return mod.lambda_handler(event, None)

    def test_hub_copy_runs_a_describe_call(self):
        response = self.call('describeServers', {})
        self.assertEqual(response['statusCode'], 200)
        self.assertEqual(json.loads(response['body'])['Servers'][0]['Id'], 'srv-1')
        self.assertEqual(self.broker.calls, ['oauth2', 'describeServers'])

    def test_hub_copy_creates_a_console_session_for_one_instance(self):
        body = [{'Name': 'Console', 'Owner': 'Administrator', 'Type': 'CONSOLE',
                 'Requirements': f"server:Host.Aws.Ec2InstanceId = '{SERVER_ID}'"}]
        response = self.call('createSessions', body)
        self.assertEqual(response['statusCode'], 200)
        self.assertIn('createSessions', self.broker.calls)

    def test_refuses_other_calls_and_session_shapes(self):
        requirement = f"server:Host.Aws.Ec2InstanceId = '{SERVER_ID}'"
        refused = [
            ('deleteSessions', [{'SessionId': 's1', 'Owner': 'Administrator'}]),
            ('getSessionConnectionData', {}),
            ('describeSessions', {'Filters': [{'Key': 'owner', 'Value': 'x'}]}),
            ('createSessions', [{'Name': 'Console', 'Owner': 'a', 'Type': 'VIRTUAL', 'Requirements': requirement}]),
            ('createSessions', [{'Name': 'Console', 'Owner': 'a', 'Type': 'CONSOLE', 'Requirements': 'true'}]),
            ('createSessions', [{'Name': 'Console', 'Owner': 'a', 'Type': 'CONSOLE',
                                 'Requirements': f"{requirement} or true"}]),
            ('createSessions', [{'Name': 'C', 'Owner': 'a', 'Type': 'CONSOLE', 'Requirements': requirement}] * 2),
        ]
        for api, body in refused:
            with self.subTest(api=api, body=body):
                self.assertEqual(self.call(api, body)['statusCode'], 400)
        self.assertEqual(self.broker.calls, [])

    def test_primary_copy_does_not_take_the_call(self):
        # The primary copy has no PRIMARY_REGION; the event is treated as an API request.
        response = self.call('describeServers', {}, env={'AWS_REGION': 'us-east-1', 'PRIMARY_REGION': ''})
        self.assertEqual(response['statusCode'], 401)
        self.assertEqual(self.broker.calls, [])

    def test_api_gateway_events_never_take_the_call(self):
        response = self.call('describeServers', {}, httpMethod='POST', requestContext={})
        self.assertEqual(response['statusCode'], 401)
        self.assertEqual(self.broker.calls, [])


if __name__ == '__main__':
    unittest.main()
