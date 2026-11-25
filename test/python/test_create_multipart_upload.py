# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

"""Unit tests for scripts/create-multipart-upload.py (run by test/create-multipart-upload.test.ts).

The target bucket is a required argument; every S3 call is stubbed.
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
SPEC = importlib.util.spec_from_file_location(
    'create_multipart_upload',
    os.path.join(HERE, '..', '..', 'scripts', 'create-multipart-upload.py'),
)
mod = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(mod)


class CreateMultipartUploadTest(unittest.TestCase):
    def test_bucket_is_required(self):
        with contextlib.redirect_stderr(io.StringIO()) as err, self.assertRaises(SystemExit) as cm:
            mod.parse_args([])
        self.assertEqual(cm.exception.code, 2)
        self.assertIn('bucket', err.getvalue())

    def test_uses_the_given_bucket(self):
        s3 = mock.Mock()
        s3.create_multipart_upload.return_value = {'UploadId': 'upload-1'}
        s3.generate_presigned_url.side_effect = lambda op, Params, ExpiresIn: f"https://example.invalid/{Params['PartNumber']}"
        out = io.StringIO()
        with mock.patch.object(mod, 'boto3', create=True) as boto3, \
                contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
            boto3.client.return_value = s3
            mod.main(['example-bucket'])

        boto3.client.assert_called_once_with('s3')
        s3.create_multipart_upload.assert_called_once_with(Bucket='example-bucket', Key=mod.key)
        result = json.loads(out.getvalue())
        self.assertEqual(result['bucket'], 'example-bucket')
        self.assertEqual(result['upload_id'], 'upload-1')
        self.assertEqual(result['num_parts'], len(result['parts']))
        for call in s3.generate_presigned_url.call_args_list:
            self.assertEqual(call.kwargs['Params']['Bucket'], 'example-bucket')
        last = result['parts'][-1]
        self.assertEqual(last['end_byte'], mod.file_size_bytes - 1)


if __name__ == '__main__':
    unittest.main()
