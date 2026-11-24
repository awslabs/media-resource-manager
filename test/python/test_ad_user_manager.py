# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

"""Unit tests for lambda/ad-user-manager (run by test/identity-resourceadmin-password.test.ts)."""

import importlib.util
import json
import os
import sys
import types
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))

# The tests need no installed packages: stub boto3 and botocore when absent.
try:
    import boto3  # noqa: F401
    from botocore.exceptions import ClientError
except ImportError:
    class ClientError(Exception):
        def __init__(self, error_response, operation_name):
            super().__init__(f"An error occurred ({error_response['Error']['Code']}) when calling the {operation_name} operation")
            self.response = error_response

    sys.modules['boto3'] = types.SimpleNamespace(client=None, resource=None)
    sys.modules['botocore'] = types.ModuleType('botocore')
    sys.modules['botocore.exceptions'] = types.SimpleNamespace(ClientError=ClientError)

SPEC = importlib.util.spec_from_file_location(
    'ad_user_manager',
    os.path.join(HERE, '..', '..', 'lambda', 'ad-user-manager', 'index.py'),
)
mod = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(mod)

DIRECTORY = 'd-1234567890'
RESOURCEADMIN_ARN = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:/MediaResourceManager/Identity/ResourceAdmin-abc123'
STORED = 'Stored-Value-For-Tests-1!'  # pragma: allowlist secret
PROPS = {
    'DirectoryId': DIRECTORY,
    'Username': 'ResourceAdmin',
    'SecretArn': RESOURCEADMIN_ARN,
    'IsAdmin': 'true',
    'Version': '11',
}


def client_error(code, op):
    return ClientError({'Error': {'Code': code, 'Message': code}}, op)


class Clients:
    """boto3.client stand-in that hands out one MagicMock per service."""

    def __init__(self):
        self.ds = mock.MagicMock(name='ds')
        self.ds_data = mock.MagicMock(name='ds-data')
        self.secrets = mock.MagicMock(name='secretsmanager')
        self.secrets.get_secret_value.return_value = {
            'SecretString': json.dumps({'username': 'ResourceAdmin', 'password': STORED})
        }

    def __call__(self, service, *args, **kwargs):
        return {'ds': self.ds, 'ds-data': self.ds_data, 'secretsmanager': self.secrets}[service]


def cfn_event(request_type, physical_id=None):
    event = {
        'RequestType': request_type,
        'ResourceProperties': PROPS,
        'ResponseURL': 'https://example.invalid/response',
        'StackId': 'stack',
        'RequestId': 'request',
        'LogicalResourceId': 'ResourceAdminUser',
    }
    if physical_id:
        event['PhysicalResourceId'] = physical_id
    return event


class Base(unittest.TestCase):
    def setUp(self):
        self.clients = Clients()
        patches = [
            mock.patch.object(mod.boto3, 'client', self.clients),
            mock.patch.object(mod, 'create_dynamodb_user'),
            mock.patch.object(mod.time, 'sleep'),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def assert_reset_to_stored_value(self):
        self.clients.secrets.get_secret_value.assert_called_once_with(SecretId=RESOURCEADMIN_ARN)
        self.clients.ds.reset_user_password.assert_called_once_with(
            DirectoryId=DIRECTORY, UserName='ResourceAdmin', NewPassword=STORED)


class CreateTest(Base):
    def test_creates_the_user_and_sets_the_stored_password(self):
        result = mod.lambda_handler(cfn_event('Create'), None)
        self.assertEqual(result, {})
        self.clients.ds_data.create_user.assert_called_once()
        self.assert_reset_to_stored_value()
        self.clients.ds_data.add_group_member.assert_called_once()

    def test_does_not_try_to_set_user_account_control(self):
        mod.lambda_handler(cfn_event('Create'), None)
        self.clients.ds_data.update_user.assert_not_called()

    def test_an_existing_user_still_gets_the_stored_password(self):
        self.clients.ds_data.create_user.side_effect = client_error('ConflictException', 'CreateUser')
        mod.lambda_handler(cfn_event('Create'), None)
        self.assert_reset_to_stored_value()


class UpdateTest(Base):
    def test_resets_the_existing_user_to_the_stored_password(self):
        result = mod.lambda_handler(cfn_event('Update', physical_id='existing'), None)
        self.assert_reset_to_stored_value()
        self.clients.ds_data.create_user.assert_not_called()
        self.clients.ds_data.update_user.assert_not_called()
        mod.create_dynamodb_user.assert_not_called()
        # The provider framework keeps the existing physical ID when the
        # handler returns none; a new ID would make CloudFormation delete the
        # old resource, which deletes the user.
        self.assertNotIn('PhysicalResourceId', result or {})

    def test_leaves_the_response_to_the_provider_framework(self):
        # The provider framework sends the response after the handler returns;
        # its SUCCESS used to replace the handler's own FAILED.
        self.assertFalse(hasattr(mod, 'send_response'))


class FailureTest(Base):
    def test_a_failed_reset_fails_the_custom_resource(self):
        self.clients.ds.reset_user_password.side_effect = client_error('AccessDeniedException', 'ResetUserPassword')
        with self.assertRaises(ClientError):
            mod.lambda_handler(cfn_event('Update', physical_id='existing'), None)

    def test_a_failed_reset_on_create_fails_the_custom_resource(self):
        self.clients.ds.reset_user_password.side_effect = client_error('AccessDeniedException', 'ResetUserPassword')
        with self.assertRaises(ClientError):
            mod.lambda_handler(cfn_event('Create'), None)

    def test_a_secret_read_failure_fails_the_custom_resource(self):
        self.clients.secrets.get_secret_value.side_effect = client_error('AccessDeniedException', 'GetSecretValue')
        with self.assertRaises(ClientError):
            mod.lambda_handler(cfn_event('Update', physical_id='existing'), None)
        self.clients.ds.reset_user_password.assert_not_called()


class ScheduledResetTest(Base):
    ENV = {'DIRECTORY_ID': DIRECTORY, 'USERNAME': 'ResourceAdmin', 'SECRET_ARN': RESOURCEADMIN_ARN}  # pragma: allowlist secret

    def test_resets_to_the_stored_password(self):
        with mock.patch.dict(os.environ, self.ENV):
            mod.scheduled_reset_handler({'source': 'aws.events'}, None)
        self.assert_reset_to_stored_value()
        self.clients.ds_data.create_user.assert_not_called()

    def test_failure_raises_and_logs_an_error(self):
        self.clients.ds.reset_user_password.side_effect = client_error('ServiceException', 'ResetUserPassword')
        with mock.patch.dict(os.environ, self.ENV), self.assertLogs(mod.logger, 'ERROR') as logs:
            with self.assertRaises(ClientError):
                mod.scheduled_reset_handler({'source': 'aws.events'}, None)
        self.assertIn('Scheduled password reset failed', '\n'.join(logs.output))


class LoggingTest(Base):
    def test_never_logs_the_password(self):
        self.clients.ds.reset_user_password.side_effect = [
            client_error('InvalidPasswordException', 'ResetUserPassword'), None, None,
        ]
        with self.assertLogs(mod.logger, 'DEBUG') as logs:
            mod.lambda_handler(cfn_event('Create'), None)
            with mock.patch.dict(os.environ, ScheduledResetTest.ENV):
                mod.scheduled_reset_handler({}, None)
        self.assertNotIn(STORED, '\n'.join(logs.output))


if __name__ == '__main__':
    unittest.main()
