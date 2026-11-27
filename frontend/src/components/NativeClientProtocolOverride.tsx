// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Admin control for a per-workstation or per-user native client protocol
 * override (#138). "Default" stores no override at this level. A set override
 * wins over Settings > Native client protocol; when the workstation and the
 * user overrides are both set and differ, TCP wins.
 */
import React, { useEffect, useState } from 'react';
import { Select, Typography } from 'antd';
import type { NativeClientTransportOverride } from '../utils/dcvClient';

const { Text } = Typography;

const DEFAULT_OPTION = 'default';

type OptionValue = typeof DEFAULT_OPTION | 'quic' | 'websocket';

export interface NativeClientProtocolOverrideProps {
  /** The stored override, or null for none. */
  value: NativeClientTransportOverride;
  /** Saves a new override; throw to show the error and keep the old value. */
  onSave: (value: NativeClientTransportOverride) => Promise<void>;
  /** What "Default" falls back to, e.g. "the user's override or Settings". */
  defaultLabel: string;
  help: string;
}

const NativeClientProtocolOverride: React.FC<NativeClientProtocolOverrideProps> = ({
  value,
  onSave,
  defaultLabel,
  help,
}) => {
  const [current, setCurrent] = useState<OptionValue>(value ?? DEFAULT_OPTION);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setCurrent(value ?? DEFAULT_OPTION);
  }, [value]);

  const handleChange = async (next: OptionValue) => {
    const previous = current;
    setCurrent(next);
    setSaving(true);
    setError('');
    try {
      await onSave(next === DEFAULT_OPTION ? null : next);
    } catch (err) {
      setCurrent(previous);
      setError((err as Error).message || 'Could not save the native client protocol');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <Select
        value={current}
        onChange={handleChange}
        loading={saving}
        disabled={saving}
        style={{ width: 260 }}
        aria-label="Native client protocol"
        options={[
          { value: DEFAULT_OPTION, label: `Default (${defaultLabel})` },
          { value: 'quic', label: 'QUIC (UDP)' },
          { value: 'websocket', label: 'TCP (WebSocket)' },
        ]}
      />
      <Text type="secondary" style={{ fontSize: 13, display: 'block', marginTop: 6 }}>
        {help}
      </Text>
      {error && (
        <Text type="danger" role="alert" style={{ fontSize: 13, display: 'block', marginTop: 4 }}>
          {error}
        </Text>
      )}
    </div>
  );
};

export default NativeClientProtocolOverride;
