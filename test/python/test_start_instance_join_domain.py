# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

"""Unit tests for joinDomain handling in lambda/start-instance (run by test/workstation-join-domain.test.ts)."""

import importlib.util
import os
import sys
import types
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))

# start-instance imports boto3 at module load; the tests stub it.
sys.modules.setdefault('boto3', types.ModuleType('boto3'))
SPEC = importlib.util.spec_from_file_location(
    'start_instance',
    os.path.join(HERE, '..', '..', 'lambda', 'start-instance', 'index.py'),
)
mod = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(mod)

INSTANCE = 'i-0123456789abcdef0'


class FakeTable:
    def __init__(self, item):
        self.item = item
        self.updates = []

    def get_item(self, Key):
        return {'Item': self.item}

    def update_item(self, **kwargs):
        self.updates.append(kwargs)


def run_handler(item, default):
    table = FakeTable(item)
    resource = mock.Mock()
    resource.Table.return_value = table
    boto3 = mock.Mock()
    boto3.resource.return_value = resource
    env = {'WORKSTATION_TABLE_NAME': 'mrm-workstations', 'AWS_REGION': 'us-east-1',
           'DEFAULT_WINDOWS_JOIN_DOMAIN': default}
    with mock.patch.object(mod, 'boto3', boto3), mock.patch.dict(os.environ, env):
        return mod.handler({'instanceId': INSTANCE}, None)


class ResolveJoinDomainTest(unittest.TestCase):
    def test_a_stored_value_wins(self):
        for default in ('true', 'false'):
            with mock.patch.dict(os.environ, {'DEFAULT_WINDOWS_JOIN_DOMAIN': default}):
                self.assertIs(mod.resolve_join_domain({'joinDomain': True}, 'Windows'), True)
                self.assertIs(mod.resolve_join_domain({'joinDomain': False}, 'Windows'), False)

    def test_a_domain_id_means_joined(self):
        with mock.patch.dict(os.environ, {'DEFAULT_WINDOWS_JOIN_DOMAIN': 'false'}):
            self.assertIs(mod.resolve_join_domain({'domainId': 'd-1234567890'}, 'Windows'), True)

    def test_an_unrecorded_windows_workstation_uses_the_deployment_default(self):
        with mock.patch.dict(os.environ, {'DEFAULT_WINDOWS_JOIN_DOMAIN': 'true'}):
            self.assertIs(mod.resolve_join_domain({}, 'Windows'), True)
        with mock.patch.dict(os.environ, {'DEFAULT_WINDOWS_JOIN_DOMAIN': 'false'}):
            self.assertIs(mod.resolve_join_domain({}, 'windows'), False)

    def test_linux_and_macos_are_never_domain_joined(self):
        with mock.patch.dict(os.environ, {'DEFAULT_WINDOWS_JOIN_DOMAIN': 'true'}):
            for platform in ('Linux', 'macOS'):
                self.assertIs(mod.resolve_join_domain({}, platform), False)
                self.assertIs(mod.resolve_join_domain({'joinDomain': True}, platform), False)


class HandlerTest(unittest.TestCase):
    def test_ad_sign_in_record_without_join_domain_takes_the_domain_joined_path(self):
        # Record shape written by instance-create-windows before joinDomain was stored.
        item = {'instanceId': INSTANCE, 'platform': 'Windows', 'region': 'us-east-1'}
        result = run_handler(item, 'true')
        self.assertIs(result['joinDomain'], True)
        self.assertTrue(result['instanceStarted'])

    def test_cognito_sign_in_record_without_join_domain_stays_standalone(self):
        item = {'instanceId': INSTANCE, 'platform': 'Windows', 'region': 'us-east-1'}
        self.assertIs(run_handler(item, 'false')['joinDomain'], False)

    def test_a_stored_join_domain_is_returned(self):
        item = {'instanceId': INSTANCE, 'platform': 'Windows', 'region': 'us-east-1', 'joinDomain': True}
        self.assertIs(run_handler(item, 'false')['joinDomain'], True)


if __name__ == '__main__':
    unittest.main()
