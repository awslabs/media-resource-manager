// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import React, { useState, useEffect, useMemo } from 'react';
import {
  Typography,
  Button,
  Table,
  Tag,
  Modal,
  Form,
  Input,
  Select,
  Checkbox,
  Breadcrumb,
  Alert,
  Space,
  Row,
  Col,
  Card,
  Tooltip,
} from 'antd';
import {
  ReloadOutlined,
  DeleteOutlined,
  EditOutlined,
  PlusOutlined,
  RobotOutlined,
  HomeOutlined,
} from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import AppLayoutAntd from '../components/AppLayoutAntd';
import InstallScriptChat from '../components/InstallScriptChat';
import AddSoftwareWizardAntd from '../components/AddSoftwareWizardAntd';
import { apiCall } from '../utils/api';
import { getAuthToken, isBedrockEnabled } from '../utils/auth';

const { Title, Text, Link } = Typography;
const { TextArea } = Input;

interface SoftwareComponent {
  softwareId: string;
  name: string;
  versionNumber: string;
  componentVersion?: string;
  category: string;
  description: string;
  componentArn: string;
  estimatedInstallTime: string;
  diskSpaceRequired: string;
  gpuRequired: boolean;
  platform?: string;
  mediaS3Uri?: string;
  mediaFileName?: string;
  sourceType?: string;
}

interface SoftwareManagementProps {
  config?: any;
  user?: any;
  isAdmin?: boolean;
  onSignOut?: () => void;
  onChangePassword?: () => void;
}

const SoftwareManagementAntd: React.FC<SoftwareManagementProps> = ({ 
  config, 
  user, 
  isAdmin = true,
  onSignOut = () => {},
  onChangePassword,
}) => {
  const [softwareLibrary, setSoftwareLibrary] = useState<SoftwareComponent[]>([]);
  const [selectedRowKeys, setSelectedRowKeys] = useState<React.Key[]>([]);
  const [selectedItems, setSelectedItems] = useState<SoftwareComponent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAddWizard, setShowAddWizard] = useState(false);
  const [isWizardGenerating, setIsWizardGenerating] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [showGenerateScriptModal, setShowGenerateScriptModal] = useState(false);
  const [bedrockEnabled, setBedrockEnabled] = useState(true);
  const [editSoftware, setEditSoftware] = useState<SoftwareComponent | null>(null);
  const [editScript, setEditScript] = useState('');
  const [updating, setUpdating] = useState(false);
  const [searchText, setSearchText] = useState('');
  const [platformFilter, setPlatformFilter] = useState<string | null>(null);
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);
  const [pageSize, setPageSize] = useState(() => {
    try {
      const saved = localStorage.getItem('software-table-pageSize');
      if (saved) return parseInt(saved, 10);
    } catch (e) {}
    return 10;
  });
  
  // Sorting state with localStorage persistence
  const [sortedInfo, setSortedInfo] = useState<{ columnKey: string; order: 'ascend' | 'descend' } | null>(() => {
    try {
      const saved = localStorage.getItem('software-table-sort');
      if (saved) return JSON.parse(saved);
    } catch (e) {}
    return { columnKey: 'name', order: 'ascend' }; // Default: sort by name ascending
  });

  const handleTableChange = (_pagination: any, _filters: any, sorter: any) => {
    const newSort = sorter.order 
      ? { columnKey: sorter.columnKey || sorter.field, order: sorter.order } 
      : null;
    setSortedInfo(newSort);
    try {
      if (newSort) {
        localStorage.setItem('software-table-sort', JSON.stringify(newSort));
      } else {
        localStorage.removeItem('software-table-sort');
      }
    } catch (e) {}
  };

  const handlePageSizeChange = (_current: number, size: number) => {
    setPageSize(size);
    try {
      localStorage.setItem('software-table-pageSize', String(size));
    } catch (e) {}
  };

  useEffect(() => {
    loadSoftwareLibrary();
    isBedrockEnabled().then(setBedrockEnabled);
  }, []);

  const loadSoftwareLibrary = async () => {
    setLoading(true);
    try {
      const token = getAuthToken();
      if (!token) return;
      const response = await apiCall('/images/software', {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
      });
      if (response.ok) {
        const data = await response.json();
        setSoftwareLibrary(data.items || []);
      }
    } catch (error) {
      console.error('Failed to load software library:', error);
    } finally {
      setLoading(false);
    }
  };

  // Filter data based on search and filters
  const filteredData = useMemo(() => {
    let filtered = [...softwareLibrary];

    if (searchText) {
      const search = searchText.toLowerCase();
      filtered = filtered.filter(item =>
        item.name?.toLowerCase().includes(search) ||
        item.description?.toLowerCase().includes(search) ||
        item.versionNumber?.toLowerCase().includes(search)
      );
    }

    if (platformFilter) {
      filtered = filtered.filter(item => (item.platform || 'Windows') === platformFilter);
    }

    if (categoryFilter) {
      filtered = filtered.filter(item => item.category === categoryFilter);
    }

    return filtered;
  }, [softwareLibrary, searchText, platformFilter, categoryFilter]);

  const columns: ColumnsType<SoftwareComponent> = [
    {
      title: 'Name',
      dataIndex: 'name',
      key: 'name',
      sorter: (a, b) => a.name.localeCompare(b.name),
      sortOrder: sortedInfo?.columnKey === 'name' ? sortedInfo.order : null,
      width: 200,
      render: (name: string, record: SoftwareComponent) => (
        <Link onClick={() => (window.location.href = `/software/${record.softwareId}`)}>
          {name}
        </Link>
      ),
    },
    {
      title: 'Version',
      dataIndex: 'versionNumber',
      key: 'version',
      render: (version) => version || 'Latest',
      sorter: (a, b) => (a.versionNumber || 'Latest').localeCompare(b.versionNumber || 'Latest'),
      sortOrder: sortedInfo?.columnKey === 'version' ? sortedInfo.order : null,
      width: 100,
    },
    {
      title: 'Platform',
      dataIndex: 'platform',
      key: 'platform',
      render: (platform) => {
        const p = platform || 'Windows';
        const color = p === 'Linux' ? 'green' : p === 'macOS' ? 'default' : 'blue';
        return <Tag color={color}>{p}</Tag>;
      },
      sorter: (a, b) => (a.platform || 'Windows').localeCompare(b.platform || 'Windows'),
      sortOrder: sortedInfo?.columnKey === 'platform' ? sortedInfo.order : null,
      width: 100,
    },
    {
      title: 'Category',
      dataIndex: 'category',
      key: 'category',
      render: (category) => (
        <Tag>{category ? category.charAt(0).toUpperCase() + category.slice(1) : 'N/A'}</Tag>
      ),
      sorter: (a, b) => (a.category || '').localeCompare(b.category || ''),
      sortOrder: sortedInfo?.columnKey === 'category' ? sortedInfo.order : null,
      width: 120,
    },
    {
      title: 'Description',
      dataIndex: 'description',
      key: 'description',
    },
  ];

  const rowSelection = {
    selectedRowKeys,
    onChange: (keys: React.Key[], rows: SoftwareComponent[]) => {
      setSelectedRowKeys(keys);
      setSelectedItems(rows);
    },
  };

  const deleteSelected = async () => {
    const errors: string[] = [];
    for (const item of selectedItems) {
      try {
        const token = getAuthToken();
        if (!token) {
          errors.push(`${item.name}: No auth token`);
          continue;
        }
        const response = await apiCall(`/images/software/${item.softwareId}`, {
          method: 'DELETE',
          headers: { 'Authorization': `Bearer ${token}` }
        });
        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          errors.push(`${item.name}: ${errorData.error || response.statusText || 'Delete failed'}`);
        }
      } catch (error) {
        errors.push(`${item.name}: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }

    setShowDeleteModal(false);
    setSelectedRowKeys([]);
    setSelectedItems([]);
    loadSoftwareLibrary();

    if (errors.length > 0) {
      setError(`Failed to delete: ${errors.join(', ')}`);
    }
  };

  const openEditModal = () => {
    if (selectedItems.length === 1) {
      setEditSoftware({ ...selectedItems[0] });
      setEditScript('');
      setShowEditModal(true);
    }
  };

  const updateSoftware = async () => {
    if (!editSoftware) return;
    setUpdating(true);
    try {
      const token = getAuthToken();
      if (!token) return;

      const payload: Record<string, any> = { ...editSoftware };
      if (editScript.trim()) {
        payload.script = editScript;
      }

      const response = await apiCall(`/images/software/${editSoftware.softwareId}`, {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (response.ok) {
        setShowEditModal(false);
        setEditSoftware(null);
        setEditScript('');
        setSelectedRowKeys([]);
        setSelectedItems([]);
        loadSoftwareLibrary();
      } else {
        const errorData = await response.json().catch(() => ({}));
        setError(errorData.error || 'Failed to update software');
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Failed to update software');
    } finally {
      setUpdating(false);
    }
  };

  return (
    <AppLayoutAntd
      isAdmin={isAdmin}
      user={user}
      config={config}
      onSignOut={onSignOut}
      onChangePassword={onChangePassword}
    >
      <div style={{ width: '100%' }}>
        {/* Breadcrumb */}
        <Breadcrumb
          style={{ marginBottom: 16 }}
          items={[
            { href: '/dashboard', title: <><HomeOutlined /> Dashboard</> },
            { title: 'Image Builder' },
            { title: 'Software' },
          ]}
        />

        {/* Header with title and actions */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
          <Title level={3} style={{ margin: 0 }}>Software Management</Title>
          <Space>
            <Tooltip title="Refresh">
              <Button icon={<ReloadOutlined />} onClick={loadSoftwareLibrary} loading={loading} />
            </Tooltip>
            <Button
              icon={<DeleteOutlined />}
              disabled={selectedRowKeys.length === 0}
              onClick={() => setShowDeleteModal(true)}
            >
              Delete
            </Button>
            <Button
              icon={<EditOutlined />}
              disabled={selectedRowKeys.length !== 1}
              onClick={openEditModal}
            >
              Edit
            </Button>
            <Button
              icon={<RobotOutlined />}
              disabled={!bedrockEnabled || selectedRowKeys.length !== 1 || selectedItems[0]?.sourceType !== 'script'}
              onClick={() => setShowGenerateScriptModal(true)}
            >
              Generate Script
            </Button>
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => setShowAddWizard(true)}
            >
              Add Software
            </Button>
          </Space>
        </div>

        {error && (
          <Alert
            message={error}
            type="error"
            closable
            onClose={() => setError(null)}
            style={{ marginBottom: 16 }}
          />
        )}

        <Card >
          {/* Filters */}
          <div style={{ marginBottom: 16, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <Input.Search
              placeholder="Search by name, description, or version"
              allowClear
              style={{ width: 300 }}
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
            />
            <Select
              placeholder="Platform"
              allowClear
              style={{ width: 150 }}
              value={platformFilter}
              onChange={setPlatformFilter}
              options={[
                { label: 'Windows', value: 'Windows' },
                { label: 'Linux', value: 'Linux' },
                { label: 'macOS', value: 'macOS' },
              ]}
            />
            <Select
              placeholder="Category"
              allowClear
              style={{ width: 150 }}
              value={categoryFilter}
              onChange={setCategoryFilter}
              options={[
                { label: 'Development', value: 'development' },
                { label: 'Media', value: 'media' },
                { label: 'System', value: 'system' },
                { label: 'Utilities', value: 'utilities' },
              ]}
            />
          </div>

          {/* Table */}
          <Table
            rowSelection={rowSelection}
            columns={columns}
            dataSource={filteredData}
            rowKey="softwareId"
            loading={loading}
            onChange={handleTableChange}
            pagination={{
              pageSize,
              showSizeChanger: true,
              pageSizeOptions: ['10', '20', '50'],
              onShowSizeChange: handlePageSizeChange,
              showTotal: (total, range) => `${range[0]}-${range[1]} of ${total} items`,
            }}
            locale={{
              emptyText: loading ? null : (
                <Space direction="vertical" align="center" style={{ padding: 24 }}>
                  <Text strong>No software components</Text>
                  <Text type="secondary">No software components to display.</Text>
                  <Button type="primary" icon={<PlusOutlined />} onClick={() => setShowAddWizard(true)}>
                    Add Software
                  </Button>
                </Space>
              ),
            }}
          />
        </Card>
      </div>

      {/* Add Software Wizard Modal */}
      <Modal
        title="Add Software to Library"
        open={showAddWizard}
        onCancel={() => {
          if (!isWizardGenerating) {
            setShowAddWizard(false);
          }
        }}
        footer={null}
        width={800}
        maskClosable={!isWizardGenerating}
      >
        <AddSoftwareWizardAntd
          onComplete={() => {
            setShowAddWizard(false);
            setIsWizardGenerating(false);
            loadSoftwareLibrary();
          }}
          onCancel={() => {
            setShowAddWizard(false);
            setIsWizardGenerating(false);
          }}
          onGeneratingChange={setIsWizardGenerating}
        />
      </Modal>

      {/* Edit Software Modal */}
      <Modal
        title="Edit Software"
        open={showEditModal}
        onCancel={() => {
          setShowEditModal(false);
          setEditSoftware(null);
          setEditScript('');
        }}
        onOk={updateSoftware}
        confirmLoading={updating}
        okText="Save Changes"
        width={700}
      >
        {editSoftware && (
          <Form layout="vertical">
            <Row gutter={16}>
              <Col span={16}>
                <Form.Item label="Software Name">
                  <Input
                    value={editSoftware.name}
                    onChange={(e) => setEditSoftware({ ...editSoftware, name: e.target.value })}
                  />
                </Form.Item>
              </Col>
              <Col span={8}>
                <Form.Item
                  label="Current Version"
                  tooltip={editSoftware.versionNumber === 'Latest' && editSoftware.componentVersion
                    ? `Internal: ${editSoftware.componentVersion}`
                    : 'Read-only'}
                >
                  <Input value={editSoftware.versionNumber || '1.0.0'} disabled />
                </Form.Item>
              </Col>
            </Row>

            <Form.Item label="Category">
              <Select
                value={editSoftware.category}
                onChange={(value) => setEditSoftware({ ...editSoftware, category: value })}
                options={[
                  { label: 'Development', value: 'development' },
                  { label: 'Media', value: 'media' },
                  { label: 'System', value: 'system' },
                  { label: 'Utilities', value: 'utilities' },
                ]}
              />
            </Form.Item>

            <Form.Item label="Description">
              <TextArea
                value={editSoftware.description}
                onChange={(e) => setEditSoftware({ ...editSoftware, description: e.target.value })}
                rows={2}
              />
            </Form.Item>

            <Form.Item label="Component ARN" tooltip="Read-only">
              <Input value={editSoftware.componentArn} disabled />
            </Form.Item>

            <Form.Item label="Platform" tooltip="Read-only">
              <Input value={editSoftware.platform || 'Windows'} disabled />
            </Form.Item>

            {editSoftware.mediaFileName && (
              <Form.Item label="Media File" tooltip="Read-only">
                <Input value={editSoftware.mediaFileName} disabled />
              </Form.Item>
            )}

            {editSoftware.sourceType === 'script' && (
              <>
                <Alert
                  type="info"
                  message={
                    editSoftware.versionNumber === 'Latest'
                      ? `To update the installation script, enter the new script below. A new component version will be created internally (${editSoftware.componentVersion || '1.0.0'} → ${(() => {
                          const v = (editSoftware.componentVersion || '1.0.0').split('.').map(Number);
                          v[2] = v[2] + 1;
                          return v.join('.');
                        })()}) but the display will remain "Latest".`
                      : `To update the installation script, enter the new script below. This will create a new component version.`
                  }
                  style={{ marginBottom: '16px' }}
                />
                <Form.Item
                  label={`Update ${editSoftware.platform === 'Linux' ? 'Bash' : 'PowerShell'} Script`}
                  tooltip="Leave empty to keep the current script unchanged"
                >
                  <TextArea
                    value={editScript}
                    onChange={(e) => setEditScript(e.target.value)}
                    placeholder={editSoftware.platform === 'Windows'
                      ? '# Enter new PowerShell script to create a new version...'
                      : '# Enter new Bash script to create a new version...'}
                    rows={8}
                  />
                </Form.Item>
              </>
            )}

            <Row gutter={16}>
              <Col span={12}>
                <Form.Item label="Estimated Install Time">
                  <Input
                    value={editSoftware.estimatedInstallTime}
                    onChange={(e) => setEditSoftware({ ...editSoftware, estimatedInstallTime: e.target.value })}
                  />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item label="Disk Space Required">
                  <Input
                    value={editSoftware.diskSpaceRequired}
                    onChange={(e) => setEditSoftware({ ...editSoftware, diskSpaceRequired: e.target.value })}
                  />
                </Form.Item>
              </Col>
            </Row>

            <Form.Item>
              <Checkbox
                checked={editSoftware.gpuRequired}
                onChange={(e) => setEditSoftware({ ...editSoftware, gpuRequired: e.target.checked })}
              >
                This software requires GPU
              </Checkbox>
            </Form.Item>
          </Form>
        )}
      </Modal>

      {/* Delete Confirmation Modal */}
      <Modal
        title={`Delete ${selectedItems.length === 1 ? 'Software Component' : 'Software Components'}`}
        open={showDeleteModal}
        onCancel={() => setShowDeleteModal(false)}
        onOk={deleteSelected}
        okText="Delete"
        okButtonProps={{ danger: true }}
      >
        <p>
          Are you sure you want to delete {selectedItems.length === 1
            ? 'this software component'
            : `these ${selectedItems.length} software components`}?
        </p>
        <Alert
          type="warning"
          message="This will permanently delete the software component(s) from both the software library database and the EC2 Image Builder component registry. Any uploaded media files will also be deleted."
          style={{ marginBottom: '16px' }}
        />
        {selectedItems.length > 0 && (
          <div>
            <Text strong>Components to be deleted:</Text>
            <ul>
              {selectedItems.map(item => (
                <li key={item.softwareId}>
                  {item.name} {item.versionNumber && `v${item.versionNumber}`}
                </li>
              ))}
            </ul>
          </div>
        )}
      </Modal>

      {/* Generate Script Modal */}
      <Modal
        title="AI Script Generator"
        open={showGenerateScriptModal}
        onCancel={() => setShowGenerateScriptModal(false)}
        footer={null}
        width={800}
      >
        {selectedItems.length === 1 && (
          <InstallScriptChat
            softwareId={selectedItems[0].softwareId}
            softwareName={selectedItems[0].name}
            platform={(selectedItems[0].platform as 'Windows' | 'Linux') || 'Windows'}
            mediaS3Uri={selectedItems[0].mediaS3Uri}
            onScriptGenerated={() => {
              loadSoftwareLibrary();
              setShowGenerateScriptModal(false);
            }}
            onClose={() => setShowGenerateScriptModal(false)}
          />
        )}
      </Modal>
    </AppLayoutAntd>
  );
};

export default SoftwareManagementAntd;
