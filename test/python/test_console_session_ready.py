# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

"""Unit tests for lambda/console-session-ready (run by test/workstation-creation-windows.test.ts)."""

import importlib.util
import os
import sys
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
SPEC = importlib.util.spec_from_file_location(
    'console_session_ready',
    os.path.join(HERE, '..', '..', 'lambda', 'console-session-ready', 'index.py'),
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

    def test_windows_creates_the_session_for_administrator(self):
        created = []

        def call(api, body):
            if api == 'createSessions':
                created.extend(body)
                return {'SuccessfulList': [{'Id': 's1'}]}
            return {'Servers': [NEW]} if api == 'describeServers' else {'Sessions': []}

        with mock.patch.dict(os.environ), mock.patch.object(mod, '_broker', return_value=call):
            os.environ.pop('SESSION_PLATFORM', None)
            out = mod.lambda_handler({'instanceId': INSTANCE, 'region': 'us-east-1'}, None)
        self.assertEqual(created[0]['Owner'], 'Administrator')
        self.assertEqual(out['consoleSessionOwner'], 'Administrator')


def fake_boto3(item, images=()):
    """A boto3 stand-in that returns one workstation record and DescribeImages result."""
    boto3 = mock.MagicMock()
    boto3.resource.return_value.Table.return_value.get_item.return_value = {'Item': item} if item else {}
    boto3.client.return_value.describe_images.return_value = {'Images': list(images)}
    return boto3


class LinuxOwnerTest(unittest.TestCase):
    def test_owner_rules_match_dcv_session_manager(self):
        cases = [
            ({'linuxDistro': 'Rocky'}, None, 'rocky'),
            ({'linuxDistro': 'rhel'}, None, 'rocky'),
            ({'linuxDistro': 'ubuntu', 'workstationName': 'rocky-01'}, None, 'ubuntu'),
            ({'workstationName': 'Rocky-0003'}, None, 'rocky'),
            ({'workstationName': 'centos-build'}, None, 'rocky'),
            ({'workstationName': 'ws-01'}, {'Name': 'Rocky-9-EC2-Base', 'Description': ''}, 'rocky'),
            ({'workstationName': 'ws-01'}, {'Name': 'golden', 'Description': 'rocky linux 9'}, 'rocky'),
            ({'workstationName': 'ws-01'}, {'Name': 'golden', 'Description': 'rhel 9'}, 'ubuntu'),
            ({'workstationName': 'ws-01'}, {'Name': 'ubuntu-jammy-22.04'}, 'ubuntu'),
            ({}, None, 'ubuntu'),
        ]
        for item, image, owner in cases:
            with self.subTest(item=item, image=image):
                self.assertEqual(mod.linux_session_owner(item, image), owner)

    def test_looks_up_the_record_and_ami_on_linux(self):
        boto3 = fake_boto3({'instanceId': INSTANCE, 'amiId': 'ami-1', 'workstationName': 'ws-01'},
                           [{'Name': 'rocky-9-base'}])
        env = {'SESSION_PLATFORM': 'Linux', 'WORKSTATION_TABLE_NAME': 'workstations'}
        with mock.patch.dict(os.environ, env), mock.patch.dict(sys.modules, {'boto3': boto3}):
            self.assertEqual(mod._session_owner({'instanceId': INSTANCE}), 'rocky')
        boto3.resource.return_value.Table.assert_called_with('workstations')
        boto3.client.return_value.describe_images.assert_called_with(ImageIds=['ami-1'])

    def test_skips_the_ami_lookup_when_the_record_names_the_distro(self):
        boto3 = fake_boto3({'instanceId': INSTANCE, 'amiId': 'ami-1', 'linuxDistro': 'ubuntu'})
        env = {'SESSION_PLATFORM': 'Linux', 'WORKSTATION_TABLE_NAME': 'workstations'}
        with mock.patch.dict(os.environ, env), mock.patch.dict(sys.modules, {'boto3': boto3}):
            self.assertEqual(mod._session_owner({'instanceId': INSTANCE}), 'ubuntu')
        boto3.client.return_value.describe_images.assert_not_called()

    def test_reuses_the_owner_from_an_earlier_check(self):
        with mock.patch.dict(os.environ, {'SESSION_PLATFORM': 'Linux'}):
            self.assertEqual(mod._session_owner({'instanceId': INSTANCE, 'consoleSessionOwner': 'rocky'}), 'rocky')

    def test_linux_creates_and_waits_for_the_distro_user_session(self):
        os.environ['AWS_REGION'] = 'us-east-1'
        created = []

        def call(api, body):
            if api == 'createSessions':
                created.extend(body)
                return {'SuccessfulList': [{'Id': 's1'}]}
            if api == 'describeServers':
                return {'Servers': [NEW]}
            # An Administrator session must not count as the Linux console session.
            return {'Sessions': [session('w1', 'READY')]}

        boto3 = fake_boto3({'instanceId': INSTANCE, 'workstationName': 'ubuntu-0001'})
        env = {'SESSION_PLATFORM': 'Linux', 'WORKSTATION_TABLE_NAME': 'workstations'}
        with mock.patch.dict(os.environ, env), mock.patch.dict(sys.modules, {'boto3': boto3}), \
                mock.patch.object(mod, '_broker', return_value=call):
            out = mod.lambda_handler({'instanceId': INSTANCE, 'region': 'us-east-1'}, None)
        self.assertFalse(out['consoleSessionReady'])
        self.assertEqual(created[0]['Owner'], 'ubuntu')
        self.assertEqual(created[0]['Type'], 'CONSOLE')
        self.assertEqual(out['consoleSessionOwner'], 'ubuntu')
        self.assertEqual(out['consoleSessionId'], 's1')

    def test_linux_ready_when_the_distro_user_session_is_ready(self):
        os.environ['AWS_REGION'] = 'us-east-1'

        def call(api, body):
            return {'Servers': [NEW]} if api == 'describeServers' else {'Sessions': [session('s1', 'READY', owner='rocky')]}

        with mock.patch.dict(os.environ, {'SESSION_PLATFORM': 'Linux'}), \
                mock.patch.object(mod, '_broker', return_value=call):
            out = mod.lambda_handler({'instanceId': INSTANCE, 'region': 'us-east-1', 'consoleSessionOwner': 'rocky'}, None)
        self.assertTrue(out['consoleSessionReady'])

    def test_record_lookup_errors_mean_not_ready(self):
        boto3 = fake_boto3(None)
        boto3.resource.side_effect = RuntimeError('throttled')
        env = {'SESSION_PLATFORM': 'Linux', 'WORKSTATION_TABLE_NAME': 'workstations'}
        os.environ['AWS_REGION'] = 'us-east-1'
        with mock.patch.dict(os.environ, env), mock.patch.dict(sys.modules, {'boto3': boto3}):
            out = mod.lambda_handler({'instanceId': INSTANCE, 'region': 'us-east-1'}, None)
        self.assertFalse(out['consoleSessionReady'])
        self.assertNotIn('consoleSessionOwner', out)


if __name__ == '__main__':
    unittest.main()
