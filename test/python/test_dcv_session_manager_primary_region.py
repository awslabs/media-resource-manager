# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

"""Unit tests for the workstation-table Region in lambda/dcv-session-manager (run by test/dcv-session-manager.test.ts).

The regional hub copy of this Lambda runs in the hub Region, but the
workstation table is in the primary Region (PRIMARY_REGION in the hub template).
"""

import importlib.util
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
    'dcv_session_manager_primary_region',
    os.path.join(HERE, '..', '..', 'lambda', 'dcv-session-manager', 'index.py'),
)
mod = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(mod)

TABLE = 'mrm-workstations'
SERVER_ID = 'i-1234567890abcdef0'
UBUNTU_RECORD = {
    'instanceId': SERVER_ID,
    'platform': 'Linux',
    'linuxDistro': 'ubuntu',
    'workstationName': 'ubuntu-0001',
    'region': 'us-west-2',
    'assignedUserId': 'artist@example.com',
}


class FakeBoto3:
    """boto3 stand-in: DynamoDB tables answer only in the Region holding them."""

    def __init__(self, table_region, items):
        self.table_region = table_region
        self.items = items
        self.resource_regions = []

    def resource(self, service, region_name=None):
        assert service == 'dynamodb'
        # Like boto3: no region_name means the Lambda's own Region.
        region_name = region_name or os.environ.get('AWS_REGION')
        self.resource_regions.append(region_name)
        fake = self

        class Table:
            def __init__(self, name):
                self.name = name

            def get_item(self, Key):
                if region_name != fake.table_region:
                    raise Exception('AccessDeniedException: not authorized in this Region')
                item = fake.items.get(Key['instanceId'])
                return {'Item': item} if item else {}

        return types.SimpleNamespace(Table=Table)


class PrimaryRegionTestBase(unittest.TestCase):
    env = {}

    def setUp(self):
        mod._dynamodb_tables.clear()
        self.fake = FakeBoto3('us-east-1', {SERVER_ID: dict(UBUNTU_RECORD)})
        patches = [
            mock.patch.object(mod, 'boto3', self.fake),
            mock.patch.dict(os.environ, {'WORKSTATION_TABLE_NAME': TABLE, **self.env}, clear=False),
            mock.patch('builtins.print'),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        if 'PRIMARY_REGION' not in self.env:
            os.environ.pop('PRIMARY_REGION', None)
        self.addCleanup(mod._dynamodb_tables.clear)


class HubCopyTest(PrimaryRegionTestBase):
    """The hub copy: AWS_REGION is the hub, PRIMARY_REGION is the primary."""

    env = {'AWS_REGION': 'us-west-2', 'PRIMARY_REGION': 'us-east-1'}

    def test_workstation_reads_use_primary_region(self):
        self.assertEqual(mod.get_workstation_region(SERVER_ID), 'us-west-2')
        mod.get_default_session_owner(SERVER_ID)
        self.assertTrue(self.fake.resource_regions)
        self.assertEqual(set(self.fake.resource_regions), {'us-east-1'})

    def test_ubuntu_record_gives_owner_ubuntu(self):
        self.assertEqual(mod.get_default_session_owner(SERVER_ID), ('ubuntu', 'us-west-2'))


class PrimaryCopyTest(PrimaryRegionTestBase):
    """The primary copy: PRIMARY_REGION unset, or equal to AWS_REGION."""

    env = {'AWS_REGION': 'us-east-1'}

    def test_unset_primary_region_uses_own_region(self):
        self.assertEqual(mod.get_default_session_owner(SERVER_ID), ('ubuntu', 'us-west-2'))
        self.assertEqual(set(self.fake.resource_regions), {'us-east-1'})

    def test_primary_region_equal_to_aws_region_is_unchanged(self):
        with mock.patch.dict(os.environ, {'PRIMARY_REGION': 'us-east-1'}):
            self.assertEqual(mod.get_workstation_region(SERVER_ID), 'us-west-2')
            self.assertEqual(mod.get_default_session_owner(SERVER_ID), ('ubuntu', 'us-west-2'))
        self.assertEqual(set(self.fake.resource_regions), {'us-east-1'})


class HubCreateSessionCheckTest(PrimaryRegionTestBase):
    """create-session's assignee check in the hub copy reads the primary-Region table."""

    env = {'AWS_REGION': 'us-west-2', 'PRIMARY_REGION': 'us-east-1'}

    def _create_session(self, username):
        event = {
            'httpMethod': 'POST',
            'requestContext': {'authorizer': {'username': username, 'isAdmin': 'false'}},
            'body': json.dumps({'action': 'create-session', 'serverId': SERVER_ID}),
        }
        # Stop at the routing step right after the check; the handler turns
        # the error into a 500. Routing is reached only past the check.
        with mock.patch.object(mod, 'get_workstation_region',
                               side_effect=RuntimeError('past the check')) as routed:
            response = mod.lambda_handler(event, None)
        return response, routed.called

    def test_assigned_user_passes_the_check(self):
        response, passed = self._create_session('artist@example.com')
        self.assertTrue(passed)
        self.assertNotEqual(response['statusCode'], 403)

    def test_unassigned_user_is_still_denied(self):
        response, passed = self._create_session('someone-else@example.com')
        self.assertFalse(passed)
        self.assertEqual(response['statusCode'], 403)
        self.assertIn('assigned to you', json.loads(response['body'])['error'])


if __name__ == '__main__':
    unittest.main()
