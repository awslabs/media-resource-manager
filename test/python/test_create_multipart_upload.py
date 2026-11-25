# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

"""Unit tests for scripts/create-multipart-upload.py (run by test/create-multipart-upload.test.ts).

The target bucket, key and file size are required arguments and the part size
is optional; every S3 call is stubbed.
"""

import contextlib
import importlib.util
import io
import json
import os
import sys
import types
import unittest
from unittest import mock

# The script imports boto3 at module load; these tests stub every AWS call.
sys.modules.setdefault('boto3', types.ModuleType('boto3'))

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, '..', '..', 'scripts', 'create-multipart-upload.py')
SPEC = importlib.util.spec_from_file_location('create_multipart_upload', SCRIPT)
mod = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(mod)

MIB = 1024 * 1024


def run_main(argv):
    s3 = mock.Mock()
    s3.create_multipart_upload.return_value = {'UploadId': 'upload-1'}
    s3.generate_presigned_url.side_effect = lambda op, Params, ExpiresIn: f"https://example.invalid/{Params['PartNumber']}"
    out = io.StringIO()
    with mock.patch.object(mod, 'boto3', create=True) as boto3, \
            contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
        boto3.client.return_value = s3
        mod.main(argv)
    boto3.client.assert_called_once_with('s3')
    return s3, json.loads(out.getvalue())


def parse_error(argv):
    with contextlib.redirect_stderr(io.StringIO()) as err, unittest.TestCase().assertRaises(SystemExit) as cm:
        mod.parse_args(argv)
    return cm.exception.code, err.getvalue()


class CreateMultipartUploadTest(unittest.TestCase):
    def test_bucket_key_and_file_size_are_required(self):
        for argv in ([], ['example-bucket'], ['example-bucket', 'media/file.zip']):
            code, err = parse_error(argv)
            self.assertEqual(code, 2, argv)
            self.assertIn('required', err)

    def test_uses_the_given_bucket_and_key_with_the_default_part_size(self):
        size = 1200 * MIB + 7
        s3, result = run_main(['example-bucket', 'media/file.zip', str(size)])

        s3.create_multipart_upload.assert_called_once_with(Bucket='example-bucket', Key='media/file.zip')
        self.assertEqual(result['bucket'], 'example-bucket')
        self.assertEqual(result['key'], 'media/file.zip')
        self.assertEqual(result['upload_id'], 'upload-1')
        self.assertEqual(result['part_size_bytes'], 500 * MIB)
        self.assertEqual(result['num_parts'], 3)
        self.assertEqual(len(result['parts']), 3)
        for call in s3.generate_presigned_url.call_args_list:
            self.assertEqual(call.kwargs['Params']['Bucket'], 'example-bucket')
            self.assertEqual(call.kwargs['Params']['Key'], 'media/file.zip')
        self.assertEqual(result['parts'][0]['end_byte'], 500 * MIB - 1)
        self.assertEqual(result['parts'][-1]['start_byte'], 1000 * MIB)
        self.assertEqual(result['parts'][-1]['end_byte'], size - 1)

    def test_part_size_option(self):
        _, result = run_main(['example-bucket', 'media/file.zip', str(250 * MIB), '--part-size', '100'])
        self.assertEqual(result['part_size_bytes'], 100 * MIB)
        self.assertEqual(result['num_parts'], 3)

    def test_rejects_invalid_sizes(self):
        for argv in (
            ['example-bucket', 'k', '0'],
            ['example-bucket', 'k', 'abc'],
            ['example-bucket', 'k', '100', '--part-size', '4'],
            ['example-bucket', 'k', str(10001 * 5 * MIB), '--part-size', '5'],
        ):
            code, _ = parse_error(argv)
            self.assertEqual(code, 2, argv)

    def test_no_object_key_in_the_script(self):
        with open(SCRIPT, encoding='utf8') as f:
            source = f.read()
        self.assertNotIn("key = '", source)
        self.assertNotIn('.zip', source)


if __name__ == '__main__':
    unittest.main()
