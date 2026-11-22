# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

"""Unit tests for lambda/console-session-ready-windows (run by test/console-session-ready-windows.test.ts)."""

import importlib.util
import os
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
SPEC = importlib.util.spec_from_file_location(
    'console_session_ready_windows',
    os.path.join(HERE, '..', '..', 'lambda', 'console-session-ready-windows', 'index.py'),
)
mod = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(mod)

INSTANCE = 'i-0123456789abcdef0'
STALE = {'Id': 'old', 'Availability': 'AVAILABLE', 'ConsoleSessionCount': 0,
         'Host': {'Aws': {'EC2InstanceId': INSTANCE}}}
NEW = {'Id': 'new', 'Availability': 'UNAVAILABLE', 'ConsoleSessionCount': 1,
       'Host': {'Aws': {'EC2InstanceId': INSTANCE}}}
OTHER = {'Id': 'other', 'ConsoleSessionCount': 1, 'Host': {'Aws': {'EC2InstanceId': 'i-0fedcba9876543210'}}}


def session(sid, state, server='new', owner='Administrator', name='Console'):
    return {'Id': sid, 'State': state, 'Owner': owner, 'Name': name, 'Server': {'Id': server}}


class EvaluateTest(unittest.TestCase):
    def test_waits_until_the_server_is_registered(self):
        self.assertEqual(mod.evaluate([OTHER], [], INSTANCE), ('wait', None))

    def test_creates_a_session_when_none_exists(self):
        self.assertEqual(mod.evaluate([STALE, NEW], [], INSTANCE), ('create', None))

    def test_registered_server_alone_is_not_ready(self):
        # The old readiness check passed here; Connect still failed.
        self.assertNotEqual(mod.evaluate([STALE], [], INSTANCE)[0], 'ready')

    def test_waits_while_the_session_is_creating(self):
        self.assertEqual(mod.evaluate([STALE, NEW], [session('s1', 'CREATING')], INSTANCE), ('wait', 's1'))

    def test_tracks_an_unplaced_session_by_id(self):
        unplaced = {'Id': 's1', 'State': 'CREATING', 'Owner': 'Administrator', 'Name': 'Console'}
        self.assertEqual(mod.evaluate([STALE, NEW], [unplaced], INSTANCE, 's1'), ('wait', 's1'))

    def test_ready_session_on_any_server_entry_is_ready(self):
        self.assertEqual(mod.evaluate([STALE, NEW], [session('s1', 'READY')], INSTANCE), ('ready', 's1'))

    def test_ready_waits_until_the_server_reports_the_session(self):
        # dcv-session-manager skips a READY session the server does not report.
        self.assertEqual(mod.evaluate([STALE], [session('s1', 'READY', server='old')], INSTANCE), ('wait', 's1'))

    def test_ignores_test_sessions_other_owners_and_other_servers(self):
        sessions = [
            session('t1', 'READY', name='test-readiness-x'),
            session('u1', 'READY', owner='someone'),
            session('o1', 'READY', server='other'),
        ]
        self.assertEqual(mod.evaluate([STALE, NEW, OTHER], sessions, INSTANCE), ('create', None))

    def test_recreates_after_the_known_session_is_gone(self):
        self.assertEqual(mod.evaluate([NEW], [session('s1', 'DELETED')], INSTANCE, 's1'), ('create', None))


class HandlerTest(unittest.TestCase):
    def setUp(self):
        os.environ['AWS_REGION'] = 'us-east-1'

    def test_skips_satellite_regions(self):
        out = mod.lambda_handler({'instanceId': INSTANCE, 'region': 'us-west-2'}, None)
        self.assertTrue(out['consoleSessionReady'])
        self.assertTrue(out['consoleSessionCheckSkipped'])
        self.assertEqual(out['consoleSessionChecks'], 1)

    def test_creates_session_and_keeps_its_id(self):
        calls = []

        def call(api, body):
            calls.append(api)
            if api == 'describeServers':
                return {'Servers': [STALE, NEW]}
            if api == 'describeSessions':
                return {'Sessions': []}
            return {'SuccessfulList': [{'Id': 's1'}]}

        with mock.patch.object(mod, '_broker', return_value=call):
            out = mod.lambda_handler({'instanceId': INSTANCE, 'region': 'us-east-1', 'consoleSessionChecks': 2}, None)
        self.assertEqual(calls, ['describeServers', 'describeSessions', 'createSessions'])
        self.assertFalse(out['consoleSessionReady'])
        self.assertEqual(out['consoleSessionId'], 's1')
        self.assertEqual(out['consoleSessionChecks'], 3)

    def test_ready_when_session_is_ready(self):
        def call(api, body):
            return {'Servers': [NEW]} if api == 'describeServers' else {'Sessions': [session('s1', 'READY')]}

        with mock.patch.object(mod, '_broker', return_value=call):
            out = mod.lambda_handler({'instanceId': INSTANCE, 'region': 'us-east-1', 'consoleSessionId': 's1'}, None)
        self.assertTrue(out['consoleSessionReady'])

    def test_follows_next_token(self):
        pages = {None: {'Sessions': [session('a', 'CREATING')], 'NextToken': 't'}, 't': {'Sessions': []}}
        items = mod._list(lambda api, body: pages[body.get('NextToken')], 'describeSessions', 'Sessions')
        self.assertEqual([s['Id'] for s in items], ['a'])

    def test_broker_errors_mean_not_ready(self):
        with mock.patch.object(mod, '_broker', side_effect=RuntimeError('broker down')):
            out = mod.lambda_handler({'instanceId': INSTANCE, 'region': 'us-east-1'}, None)
        self.assertFalse(out['consoleSessionReady'])


if __name__ == '__main__':
    unittest.main()
