# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

"""Unit tests for browserGatewayUrl in lambda/dcv-session-manager (run by test/dcv-session-manager.test.ts)."""

import importlib.util
import os
import sys
import types
import unittest
from unittest import mock

# The Lambda imports boto3 at module load; these tests stub every AWS call.
sys.modules.setdefault('boto3', types.ModuleType('boto3'))

HERE = os.path.dirname(os.path.abspath(__file__))
SPEC = importlib.util.spec_from_file_location(
    'dcv_session_manager',
    os.path.join(HERE, '..', '..', 'lambda', 'dcv-session-manager', 'index.py'),
)
mod = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(mod)

GATEWAY = 'gw.example.com'


class NotFound(Exception):
    pass


class NormalizeTest(unittest.TestCase):
    def test_bare_domain_becomes_an_https_origin(self):
        self.assertEqual(mod.normalize_browser_gateway_url('d111111abcdef8.cloudfront.net'),
                         'https://d111111abcdef8.cloudfront.net')

    def test_url_is_cut_to_its_origin(self):
        self.assertEqual(mod.normalize_browser_gateway_url(' https://d111111abcdef8.cloudfront.net/x?y '),
                         'https://d111111abcdef8.cloudfront.net')
        self.assertEqual(mod.normalize_browser_gateway_url('https://gw.example.com:8443'),
                         'https://gw.example.com:8443')

    def test_rejects_empty_and_non_https(self):
        for value in (None, '', '   ', 'http://gw.example.com', 'wss://gw.example.com', 42):
            self.assertIsNone(mod.normalize_browser_gateway_url(value), value)


class BrowserGatewayUrlForTest(unittest.TestCase):
    def test_uses_the_published_url(self):
        self.assertEqual(mod.browser_gateway_url_for(GATEWAY, 'd111111abcdef8.cloudfront.net'),
                         'https://d111111abcdef8.cloudfront.net')

    def test_falls_back_to_the_gateway_on_8443(self):
        self.assertEqual(mod.browser_gateway_url_for(GATEWAY, None), 'https://gw.example.com:8443')
        self.assertEqual(mod.browser_gateway_url_for(GATEWAY, 'http://bad'), 'https://gw.example.com:8443')


class SsmLookupTest(unittest.TestCase):
    def test_reads_the_parameter_under_the_product_prefix(self):
        ssm = mock.Mock()
        ssm.get_parameter.return_value = {'Parameter': {'Value': 'd111111abcdef8.cloudfront.net'}}
        self.assertEqual(mod.get_browser_gateway_url(ssm, 'MediaResourceManager'),
                         'https://d111111abcdef8.cloudfront.net')
        ssm.get_parameter.assert_called_once_with(
            Name='/MediaResourceManager/DCV/ConnectionGateway/BrowserGatewayUrl')

    def test_missing_or_unreadable_parameter_means_none(self):
        ssm = mock.Mock()
        ssm.get_parameter.side_effect = NotFound('ParameterNotFound')
        self.assertIsNone(mod.get_browser_gateway_url(ssm, 'MediaResourceManager'))


class RegionalHubRecordTest(unittest.TestCase):
    def test_returns_the_hub_records_browser_gateway_url(self):
        table = mock.Mock()
        table.get_item.return_value = {'Item': {
            'region': 'us-west-2',
            'sessionManagerEndpoint': 'sm.example.com',
            'connectionGatewayEndpoint': 'gw-west.example.com',
            'browserGatewayUrl': 'https://d222222abcdef8.cloudfront.net',
        }}
        regional_ssm = mock.Mock()
        regional_ssm.get_parameter.return_value = {'Parameter': {'Value': 'v'}}
        fake_boto3 = types.SimpleNamespace(
            resource=lambda *_a, **_k: types.SimpleNamespace(Table=lambda _n: table),
            client=lambda *_a, **_k: regional_ssm,
        )
        with mock.patch.object(mod, 'boto3', fake_boto3), \
                mock.patch.dict(os.environ, {'AWS_REGION': 'us-east-1'}):
            endpoints = mod.get_regional_dcv_endpoints('us-west-2')
        self.assertEqual(endpoints['connection_gateway_endpoint'], 'gw-west.example.com')
        self.assertEqual(endpoints['browser_gateway_url'], 'https://d222222abcdef8.cloudfront.net')


if __name__ == '__main__':
    unittest.main()
