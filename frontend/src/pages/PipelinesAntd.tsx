// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import React, { useState, useEffect, useMemo } from 'react';
import {
  Card,
  Table,
  Button,
  Modal,
  Form,
  Input,
  Select,
  Alert,
  Tag,
  Space,
  Typography,
  Breadcrumb,
  Tooltip,
} from 'antd';
import {
  PlusOutlined,
  DeleteOutlined,
  ReloadOutlined,
  HomeOutlined,
  EditOutlined,
  PlayCircleOutlined,
  CloseCircleOutlined,
} from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import AppLayoutAntd from '../components/AppLayoutAntd';
import { getAuthToken } from '../utils/auth';
import { apiCall } from '../utils/api';

const { Title, Text } = Typography;

interface PipelineComponent {
  name: string;
  componentArn: string;
  type?: string;
}

interface ImagePipeline {
  pipelineId: string;
  name: string;
  description?: string;
  status: 'CREATED' | 'BUILDING' | 'COMPLETED' | 'FAILED' | string;
  baseImageId: string;
  baseOsVersion?: string;
  components: PipelineComponent[];
  createdAt: string;
  updatedAt: string;
  pipelineArn: string;
  isSystemPipeline?: boolean;
}

interface SoftwareComponent {
  componentId: string;
  name: string;
  componentArn: string;
  componentVersion?: string;
  versionNumber?: string;
}

interface PipelinesAntdProps {
  user: any;
  isAdmin: boolean;
  config?: any;
  onSignOut: () => void;
  onChangePassword?: () => void;
}

const PipelinesAntd: React.FC<PipelinesAntdProps> = ({
  user,
  isAdmin,
  config,
  onSignOut,
  onChangePassword,
}) => {
  const [pipelines, setPipelines] = useState<ImagePipeline[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedRowKeys, setSelectedRowKeys] = useState<React.Key[]>([]);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [editingPipeline, setEditingPipeline] = useState<ImagePipeline | null>(null);
  const [editPipelineComponents, setEditPipelineComponents] = useState<PipelineComponent[]>([]);
  const [softwareLibrary, setSoftwareLibrary] = useState<SoftwareComponent[]>([]);
  const [deleting, setDeleting] = useState(false);
  const [building, setBuilding] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [alert, setAlert] = useState<{ type: 'success' | 'error' | 'info' | 'warning'; message: string } | null>(null);
  const [filterText, setFilterText] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  // Table preferences with localStorage persistence
  const [sortedInfo, setSortedInfo] = useState<{ columnKey: string; order: 'ascend' | 'descend' } | null>(() => {
    try {
      const saved = localStorage.getItem('pipelines-table-sort');
      if (saved) return JSON.parse(saved);
    } catch (e) {}
    return { columnKey: 'name', order: 'ascend' };
  });

  const [pageSize, setPageSize] = useState(() => {
    try {
      const saved = localStorage.getItem('pipelines-table-pageSize');
      if (saved) return parseInt(saved, 10);
    } catch (e) {}
    return 10;
  });

  useEffect(() => {
    fetchPipelines();
  }, []);

  const fetchPipelines = async () => {
    try {
      setLoading(true);
      const token = getAuthToken();
      if (!token) throw new Error('No current user');

      const response = await apiCall('/images/pipelines', {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      });

      if (response.ok) {
        const data = await response.json();
        setPipelines(data.pipelines || []);
      } else {
        throw new Error(`HTTP ${response.status}`);
      }
    } catch (error) {
      console.error('Error fetching pipelines:', error);
      setAlert({ type: 'error', message: `Failed to fetch pipelines: ${(error as Error).message}` });
      setPipelines([]);
    } finally {
      setLoading(false);
    }
  };

  const fetchSoftwareLibrary = async () => {
    try {
      const token = getAuthToken();
      if (!token) return;

      const response = await apiCall('/images/software', {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      });

      if (response.ok) {
        const data = await response.json();
        setSoftwareLibrary(data.items || []);
      }
    } catch (error) {
      console.error('Error fetching software library:', error);
    }
  };

  const selectedPipelines = useMemo(() => {
    return pipelines.filter((p) => selectedRowKeys.includes(p.pipelineId));
  }, [pipelines, selectedRowKeys]);

  const filteredPipelines = useMemo(() => {
    let filtered = [...pipelines];

    if (filterText) {
      const searchText = filterText.toLowerCase();
      filtered = filtered.filter(
        (p) =>
          p.name?.toLowerCase().includes(searchText) ||
          p.baseOsVersion?.toLowerCase().includes(searchText) ||
          p.baseImageId?.toLowerCase().includes(searchText)
      );
    }

    if (statusFilter) {
      filtered = filtered.filter((p) => p.status?.toUpperCase() === statusFilter.toUpperCase());
    }

    return filtered;
  }, [pipelines, filterText, statusFilter]);

  const canDelete = selectedRowKeys.length > 0 && !selectedPipelines.every((p) => p.isSystemPipeline);

  const handleTableChange = (pagination: any, filters: any, sorter: any) => {
    const newSort = sorter.order 
      ? { columnKey: sorter.columnKey || sorter.field, order: sorter.order }
      : null;
    setSortedInfo(newSort);
    try {
      if (newSort) {
        localStorage.setItem('pipelines-table-sort', JSON.stringify(newSort));
      } else {
        localStorage.removeItem('pipelines-table-sort');
      }
    } catch (e) {}
  };

  const handlePageSizeChange = (current: number, size: number) => {
    setPageSize(size);
    try {
      localStorage.setItem('pipelines-table-pageSize', String(size));
    } catch (e) {}
  };

  const handleEditClick = () => {
    if (selectedRowKeys.length !== 1) return;
    const pipeline = selectedPipelines[0];
    setEditingPipeline(pipeline);
    setEditPipelineComponents([...pipeline.components]);
    fetchSoftwareLibrary();
    setShowEditModal(true);
  };

  const handleUpdatePipeline = async () => {
    if (!editingPipeline) return;

    setUpdating(true);
    try {
      const token = getAuthToken();
      if (!token) throw new Error('No auth token');

      const response = await apiCall(`/images/pipelines/${editingPipeline.pipelineId}`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          components: editPipelineComponents,
        }),
      });

      if (response.ok) {
        const data = await response.json();
        setAlert({
          type: 'success',
          message: `Pipeline updated successfully. New recipe version: ${data.recipeVersion}`,
        });
        setShowEditModal(false);
        setEditingPipeline(null);
        setSelectedRowKeys([]);
        fetchPipelines();
      } else {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to update pipeline');
      }
    } catch (error) {
      console.error('Error updating pipeline:', error);
      setAlert({ type: 'error', message: `Failed to update pipeline: ${(error as Error).message}` });
    } finally {
      setUpdating(false);
    }
  };

  const handleDeletePipelines = async () => {
    if (selectedPipelines.length === 0) return;

    setDeleting(true);
    try {
      const token = getAuthToken();
      if (!token) throw new Error('No current user');

      await Promise.all(
        selectedPipelines
          .filter((p) => !p.isSystemPipeline)
          .map((pipeline) =>
            apiCall(`/images/pipelines/${pipeline.pipelineId}`, {
              method: 'DELETE',
              headers: { Authorization: `Bearer ${token}` },
            })
          )
      );

      const deletedCount = selectedPipelines.filter((p) => !p.isSystemPipeline).length;
      setAlert({
        type: 'success',
        message: `${deletedCount} pipeline(s) deleted successfully`,
      });
      setSelectedRowKeys([]);
      setShowDeleteModal(false);
      fetchPipelines();
    } catch (error) {
      console.error('Error deleting pipelines:', error);
      setAlert({ type: 'error', message: 'Failed to delete pipeline(s)' });
    } finally {
      setDeleting(false);
    }
  };

  const handleBuildPipelines = async () => {
    if (selectedPipelines.length === 0) return;

    setBuilding(true);
    try {
      const token = getAuthToken();
      if (!token) throw new Error('No current user');

      await Promise.all(
        selectedPipelines.map((pipeline) =>
          apiCall(`/images/pipelines/${pipeline.pipelineId}/execute`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` },
          })
        )
      );

      setAlert({
        type: 'success',
        message: `${selectedPipelines.length} pipeline build(s) started successfully`,
      });
      fetchPipelines();
    } catch (error) {
      console.error('Error starting pipeline builds:', error);
      setAlert({ type: 'error', message: 'Failed to start pipeline build(s)' });
    } finally {
      setBuilding(false);
    }
  };

  const updateComponentVersion = (index: number, newArn: string, newName: string) => {
    const updated = [...editPipelineComponents];
    updated[index] = {
      ...updated[index],
      componentArn: newArn,
      name: newName,
    };
    setEditPipelineComponents(updated);
  };

  const removeComponent = (index: number) => {
    const updated = editPipelineComponents.filter((_, i) => i !== index);
    setEditPipelineComponents(updated);
  };

  const addComponent = (componentArn: string) => {
    const selectedSw = softwareLibrary.find((sw) => sw.componentArn === componentArn);
    if (selectedSw) {
      setEditPipelineComponents([
        ...editPipelineComponents,
        {
          name: selectedSw.name,
          componentArn: selectedSw.componentArn,
          type: 'BUILD',
        },
      ]);
    }
  };

  const getComponentOptions = (currentComponent: PipelineComponent) => {
    const arnParts = currentComponent.componentArn?.split('/') || [];
    const componentNameFromArn = arnParts[1]?.toLowerCase() || '';

    const matchingComponents = softwareLibrary.filter((sw) => {
      const swArnParts = sw.componentArn?.split('/') || [];
      const swComponentName = swArnParts[1]?.toLowerCase() || '';
      return swComponentName === componentNameFromArn;
    });

    return matchingComponents.map((sw) => ({
      label: `${sw.name} (${sw.componentVersion || sw.versionNumber || 'Latest'})`,
      value: sw.componentArn,
    }));
  };

  const getAvailableComponentsToAdd = () => {
    const currentArns = new Set(
      editPipelineComponents.map((c) => {
        const parts = c.componentArn?.split('/') || [];
        return parts[1]?.toLowerCase() || '';
      })
    );

    return softwareLibrary
      .filter((sw) => {
        const swParts = sw.componentArn?.split('/') || [];
        const swName = swParts[1]?.toLowerCase() || '';
        return !currentArns.has(swName);
      })
      .map((sw) => ({
        label: `${sw.name} (${sw.componentVersion || sw.versionNumber || 'Latest'})`,
        value: sw.componentArn,
      }));
  };

  const formatStatus = (status: string) => {
    if (status.includes('-')) {
      return status
        .split('-')
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
        .join(' ');
    }
    if (status.includes('_')) {
      return status
        .split('_')
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
        .join(' ');
    }
    return status.charAt(0).toUpperCase() + status.slice(1).toLowerCase();
  };

  const getStatusColor = (status: string) => {
    const normalizedStatus = status.toUpperCase().replace(/-/g, '_');
    switch (normalizedStatus) {
      case 'COMPLETED':
        return 'success';
      case 'BUILDING':
      case 'SIP_DISABLE_IN_PROGRESS':
      case 'SIP_DISABLE_STARTING':
        return 'processing';
      case 'FAILED':
      case 'SIP_DISABLE_FAILED':
        return 'error';
      case 'CREATED':
        return 'default';
      case 'SIP_DISABLE_COMPLETE':
        return 'processing';
      default:
        return 'default';
    }
  };

  const columns: ColumnsType<ImagePipeline> = [
    {
      title: 'Name',
      dataIndex: 'name',
      key: 'name',
      sorter: (a, b) => a.name.localeCompare(b.name),
      sortOrder: sortedInfo?.columnKey === 'name' ? sortedInfo.order : null,
      render: (text, record) => (
        <Space>
          <span>{text}</span>
          {record.isSystemPipeline && <Tag color="blue">System</Tag>}
        </Space>
      ),
    },
    {
      title: 'Base Image',
      key: 'baseImage',
      sorter: (a, b) => (a.baseOsVersion || a.baseImageId || '').localeCompare(b.baseOsVersion || b.baseImageId || ''),
      sortOrder: sortedInfo?.columnKey === 'baseImage' ? sortedInfo.order : null,
      render: (_, record) => record.baseOsVersion || record.baseImageId,
    },
    {
      title: 'Components',
      dataIndex: 'components',
      key: 'components',
      sorter: (a, b) => (a.components?.length || 0) - (b.components?.length || 0),
      sortOrder: sortedInfo?.columnKey === 'components' ? sortedInfo.order : null,
      render: (components) => components?.length || 0,
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      sorter: (a, b) => a.status.localeCompare(b.status),
      sortOrder: sortedInfo?.columnKey === 'status' ? sortedInfo.order : null,
      render: (status) => (
        <Tag color={getStatusColor(status)}>{formatStatus(status)}</Tag>
      ),
    },
    {
      title: 'Created',
      dataIndex: 'createdAt',
      key: 'createdAt',
      sorter: (a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''),
      sortOrder: sortedInfo?.columnKey === 'createdAt' ? sortedInfo.order : null,
      render: (date) => (date ? new Date(date).toLocaleDateString() : '-'),
    },
  ];

  const statusFilterOptions = [
    { label: 'All Statuses', value: '' },
    { label: 'Created', value: 'CREATED' },
    { label: 'Building', value: 'BUILDING' },
    { label: 'Completed', value: 'COMPLETED' },
    { label: 'Failed', value: 'FAILED' },
  ];

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
            { title: 'Pipelines' },
          ]}
        />

        {/* Header with title and actions */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
          <Title level={3} style={{ margin: 0 }}>Image Pipelines</Title>
          <Space>
            <Tooltip title="Refresh">
              <Button icon={<ReloadOutlined />} onClick={fetchPipelines} loading={loading} />
            </Tooltip>
            <Button
              icon={<EditOutlined />}
              onClick={handleEditClick}
              disabled={selectedRowKeys.length !== 1}
            >
              Edit
            </Button>
            <Button
              icon={<DeleteOutlined />}
              onClick={() => setShowDeleteModal(true)}
              disabled={!canDelete}
            >
              Delete
            </Button>
            <Button
              icon={<PlayCircleOutlined />}
              onClick={handleBuildPipelines}
              disabled={selectedRowKeys.length === 0}
              loading={building}
            >
              Build Image
            </Button>
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => (window.location.href = '/images/create')}
            >
              Create Pipeline
            </Button>
          </Space>
        </div>

        {alert && (
          <Alert
            type={alert.type}
            message={alert.message}
            closable
            onClose={() => setAlert(null)}
            style={{ marginBottom: 16 }}
          />
        )}

        <Card >
          {/* Filters */}
          <Space style={{ marginBottom: 16 }}>
            <Input.Search
              placeholder="Search by name or base image"
              allowClear
              value={filterText}
              onChange={(e) => setFilterText(e.target.value)}
              style={{ width: 250 }}
            />
            <Select
              placeholder="Status"
              allowClear
              value={statusFilter || undefined}
              onChange={(value) => setStatusFilter(value || '')}
              options={statusFilterOptions.filter((o) => o.value)}
              style={{ width: 140 }}
            />
          </Space>

          <Table
            rowSelection={{
              selectedRowKeys,
              onChange: setSelectedRowKeys,
            }}
            columns={columns}
            dataSource={filteredPipelines}
            rowKey="pipelineId"
            loading={loading}
            onChange={handleTableChange}
            pagination={{
              pageSize,
              showSizeChanger: true,
              pageSizeOptions: ['10', '20', '50'],
              onShowSizeChange: handlePageSizeChange,
              showTotal: (total) => `${total} pipelines`,
            }}
            locale={{
              emptyText: loading ? null : (
                <Space direction="vertical" align="center" style={{ padding: 24 }}>
                  <Text strong>No pipelines</Text>
                  <Text type="secondary">No image pipelines to display.</Text>
                  <Button type="primary" onClick={() => (window.location.href = '/images/create')}>
                    Create Pipeline
                  </Button>
                </Space>
              ),
            }}
          />
        </Card>
      </div>

      {/* Delete Confirmation Modal */}
      <Modal
        title={`Delete ${selectedPipelines.length === 1 ? 'Pipeline' : 'Pipelines'}`}
        open={showDeleteModal}
        onCancel={() => setShowDeleteModal(false)}
        onOk={handleDeletePipelines}
        confirmLoading={deleting}
        okText={`Delete ${selectedPipelines.length === 1 ? 'Pipeline' : 'Pipelines'}`}
        okButtonProps={{ danger: true }}
      >
        <Alert
          type="warning"
          message="This action cannot be undone."
          style={{ marginBottom: 16 }}
        />
        <div>
          <Text>
            Are you sure you want to delete{' '}
            {selectedPipelines.length === 1 ? 'the pipeline' : `${selectedPipelines.length} pipelines`}?
          </Text>
          {selectedPipelines.length === 1 ? (
            <Text strong> {selectedPipelines[0]?.name}</Text>
          ) : (
            <ul>
              {selectedPipelines.map((pipeline) => (
                <li key={pipeline.pipelineId}>
                  <Text strong>{pipeline.name}</Text>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div style={{ marginTop: 16 }}>
          <Text strong>This will permanently delete:</Text>
          <ul>
            <li>Image Builder Pipeline{selectedPipelines.length > 1 ? 's' : ''}</li>
            <li>Image Recipe{selectedPipelines.length > 1 ? 's' : ''}</li>
            <li>Infrastructure Configuration{selectedPipelines.length > 1 ? 's' : ''}</li>
            <li>Distribution Configuration{selectedPipelines.length > 1 ? 's' : ''}</li>
            <li>Custom Components (if any)</li>
            <li>Associated AMIs from your account</li>
            <li>AMI records from the management system</li>
          </ul>
        </div>
      </Modal>

      {/* Edit Pipeline Modal */}
      <Modal
        title="Edit Pipeline Components"
        open={showEditModal}
        onCancel={() => {
          setShowEditModal(false);
          setEditingPipeline(null);
        }}
        onOk={handleUpdatePipeline}
        confirmLoading={updating}
        okText="Update Pipeline"
        okButtonProps={{ disabled: editPipelineComponents.length === 0 }}
        width={700}
      >
        <Alert
          type="info"
          message="Updating components will create a new recipe version. The pipeline will use the updated recipe for future builds."
          style={{ marginBottom: 16 }}
        />

        {editingPipeline && (
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            <div>
              <Text strong>Pipeline Name:</Text> {editingPipeline.name}
            </div>
            <div>
              <Text strong>Base Image:</Text> {editingPipeline.baseOsVersion || editingPipeline.baseImageId}
            </div>

            <div>
              <Text strong>Components:</Text>
              <Text type="secondary" style={{ display: 'block', marginBottom: 8 }}>
                Select component versions or remove components.
              </Text>

              {editPipelineComponents.map((component, index) => {
                const options = getComponentOptions(component);
                const currentOption = options.find((opt) => opt.value === component.componentArn);

                return (
                  <div
                    key={index}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      marginBottom: 8,
                    }}
                  >
                    <div style={{ flex: 1 }}>
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        {component.name}
                      </Text>
                      {options.length > 0 ? (
                        <Select
                          style={{ width: '100%' }}
                          value={component.componentArn}
                          onChange={(value) => {
                            const selectedSw = softwareLibrary.find((sw) => sw.componentArn === value);
                            updateComponentVersion(index, value, selectedSw?.name || component.name);
                          }}
                          options={[
                            {
                              label: `${component.name} (current)`,
                              value: component.componentArn,
                            },
                            ...options.filter((opt) => opt.value !== component.componentArn),
                          ]}
                        />
                      ) : (
                        <Input value={component.componentArn} disabled />
                      )}
                    </div>
                    <Button
                      icon={<CloseCircleOutlined />}
                      type="text"
                      danger
                      onClick={() => removeComponent(index)}
                    />
                  </div>
                );
              })}

              {editPipelineComponents.length === 0 && (
                <Alert
                  type="warning"
                  message="At least one component is required. Add a component or cancel to keep the current configuration."
                />
              )}
            </div>

            <div>
              <Text strong>Add Component:</Text>
              <Text type="secondary" style={{ display: 'block', marginBottom: 8 }}>
                Add additional components from the Software Library.
              </Text>
              {getAvailableComponentsToAdd().length > 0 ? (
                <Select
                  style={{ width: '100%' }}
                  placeholder="Select a component to add..."
                  value={undefined}
                  onChange={(value) => {
                    if (value) addComponent(value);
                  }}
                  options={getAvailableComponentsToAdd()}
                  showSearch
                  filterOption={(input, option) =>
                    (option?.label ?? '').toLowerCase().includes(input.toLowerCase())
                  }
                />
              ) : (
                <Text type="secondary">
                  {softwareLibrary.length === 0
                    ? 'No components available in the Software Library. Add components in the Software page first.'
                    : 'All available components are already in this pipeline.'}
                </Text>
              )}
            </div>
          </Space>
        )}
      </Modal>
    </AppLayoutAntd>
  );
};

export default PipelinesAntd;
