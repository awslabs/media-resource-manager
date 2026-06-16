// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  Card,
  Alert,
  Typography,
  Breadcrumb,
  Space,
  Button,
  Descriptions,
  message,
  Table,
  Upload,
  Progress,
  Modal,
  Input,
  Empty,
  List,
  Tag,
  Collapse,
} from 'antd';
import type { UploadProps } from 'antd';
import {
  HomeOutlined,
  CopyOutlined,
  CloudUploadOutlined,
  DownloadOutlined,
  FolderOutlined,
  FileOutlined,
  DeleteOutlined,
  ReloadOutlined,
  ArrowLeftOutlined,
  InboxOutlined,
  FolderAddOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  LoadingOutlined,
  SettingOutlined,
} from '@ant-design/icons';
import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3';
import { Upload as S3Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { fromCognitoIdentityPool } from '@aws-sdk/credential-providers';
import AppLayoutAntd from '../components/AppLayoutAntd';

const { Text, Paragraph } = Typography;

interface BucketsAntdProps {
  user: any;
  isAdmin: boolean;
  config?: any;
  onSignOut: () => void;
  onChangePassword?: () => void;
}

interface S3Object {
  key: string;
  name: string;
  size?: number;
  lastModified?: Date;
  isFolder: boolean;
}

interface UploadItem {
  id: string;
  name: string;
  path: string;
  size: number;
  status: 'pending' | 'uploading' | 'success' | 'error';
  progress: number;
  error?: string;
}

const BucketsAntd: React.FC<BucketsAntdProps> = ({
  user,
  isAdmin,
  config,
  onSignOut,
  onChangePassword,
}) => {
  const [loading, setLoading] = useState(false);
  const [objects, setObjects] = useState<S3Object[]>([]);
  const [currentPrefix, setCurrentPrefix] = useState('');
  const [configError, setConfigError] = useState<string | null>(null);
  const [s3Client, setS3Client] = useState<S3Client | null>(null);
  const [uploadQueue, setUploadQueue] = useState<UploadItem[]>([]);
  const [newFolderModalVisible, setNewFolderModalVisible] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [messageApi, contextHolder] = message.useMessage();
  const [isDragging, setIsDragging] = useState(false);
  const dropZoneRef = useRef<HTMLDivElement>(null);
  const uploadedPathsRef = useRef<Set<string>>(new Set());
  
  // Pagination state
  const [continuationToken, setContinuationToken] = useState<string | undefined>(undefined);
  const [hasMore, setHasMore] = useState(false);
  const [totalLoaded, setTotalLoaded] = useState(0);

  // Initialize S3 client with Cognito Identity Pool credentials
  useEffect(() => {
    const initializeS3Client = async () => {
      if (!config?.identityPoolId || !config?.mediaBucketName) {
        setConfigError('Storage Browser requires Identity Pool and Media Bucket configuration. Please ensure the CDK stack has been deployed with these resources.');
        return;
      }

      try {
        // Get the ID token from session storage
        const idToken = sessionStorage.getItem('auth-token');
        if (!idToken) {
          setConfigError('No authentication token found. Please sign in again.');
          return;
        }

        // Create S3 client with Cognito Identity Pool credentials
        // Disable request checksums to avoid CRC32 multipart upload issues in browser
        const client = new S3Client({
          region: config.region,
          credentials: fromCognitoIdentityPool({
            clientConfig: { region: config.region },
            identityPoolId: config.identityPoolId,
            logins: {
              [`cognito-idp.${config.region}.amazonaws.com/${config.cognitoUserPoolId}`]: idToken,
            },
          }),
          requestChecksumCalculation: 'WHEN_REQUIRED',
          responseChecksumValidation: 'WHEN_REQUIRED',
        });

        setS3Client(client);
        setConfigError(null);
      } catch (error) {
        console.error('Failed to initialize S3 client:', error);
        setConfigError(`Failed to initialize S3 client: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    };

    initializeS3Client();
  }, [config]);

  // Load objects when client is ready or prefix changes
  const loadObjects = useCallback(async (loadMore = false) => {
    if (!s3Client || !config?.mediaBucketName) return;

    setLoading(true);
    try {
      const command = new ListObjectsV2Command({
        Bucket: config.mediaBucketName,
        Prefix: currentPrefix,
        Delimiter: '/',
        MaxKeys: 100, // Load 100 items at a time
        ContinuationToken: loadMore ? continuationToken : undefined,
      });

      const response = await s3Client.send(command);
      const items: S3Object[] = [];

      // Add folders (common prefixes)
      if (response.CommonPrefixes) {
        for (const prefix of response.CommonPrefixes) {
          if (prefix.Prefix) {
            const folderName = prefix.Prefix.slice(currentPrefix.length, -1);
            items.push({
              key: prefix.Prefix,
              name: folderName,
              isFolder: true,
            });
          }
        }
      }

      // Add files
      if (response.Contents) {
        for (const obj of response.Contents) {
          if (obj.Key && obj.Key !== currentPrefix) {
            const fileName = obj.Key.slice(currentPrefix.length);
            if (fileName) {
              items.push({
                key: obj.Key,
                name: fileName,
                size: obj.Size,
                lastModified: obj.LastModified,
                isFolder: false,
              });
            }
          }
        }
      }

      // Update state
      if (loadMore) {
        setObjects(prev => [...prev, ...items]);
        setTotalLoaded(prev => prev + items.length);
      } else {
        setObjects(items);
        setTotalLoaded(items.length);
      }
      
      setContinuationToken(response.NextContinuationToken);
      setHasMore(!!response.NextContinuationToken);
    } catch (error) {
      console.error('Failed to list objects:', error);
      messageApi.error('Failed to load bucket contents');
    } finally {
      setLoading(false);
    }
  }, [s3Client, config?.mediaBucketName, currentPrefix, continuationToken, messageApi]);

  // Reset pagination when prefix changes
  useEffect(() => {
    setContinuationToken(undefined);
    setHasMore(false);
    setTotalLoaded(0);
  }, [currentPrefix]);

  useEffect(() => {
    if (s3Client) {
      loadObjects(false);
    }
  }, [s3Client, currentPrefix]); // eslint-disable-line react-hooks/exhaustive-deps

  const navigateToFolder = (prefix: string) => {
    setCurrentPrefix(prefix);
  };

  const navigateUp = () => {
    if (!currentPrefix) return;
    const parts = currentPrefix.split('/').filter(Boolean);
    parts.pop();
    setCurrentPrefix(parts.length > 0 ? parts.join('/') + '/' : '');
  };

  const downloadFile = async (key: string, fileName: string) => {
    if (!s3Client || !config?.mediaBucketName) return;

    try {
      const command = new GetObjectCommand({
        Bucket: config.mediaBucketName,
        Key: key,
      });

      const url = await getSignedUrl(s3Client, command, { expiresIn: 3600 });
      
      // Create a temporary link and click it
      const link = document.createElement('a');
      link.href = url;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      
      messageApi.success(`Downloading ${fileName}`);
    } catch (error) {
      console.error('Failed to download file:', error);
      messageApi.error('Failed to download file');
    }
  };

  const deleteObject = async (key: string, isFolder: boolean) => {
    if (!s3Client || !config?.mediaBucketName) return;

    Modal.confirm({
      title: `Delete ${isFolder ? 'folder' : 'file'}?`,
      content: `Are you sure you want to delete "${key}"?${isFolder ? ' This will delete all contents.' : ''}`,
      okText: 'Delete',
      okType: 'danger',
      onOk: async () => {
        try {
          if (isFolder) {
            // For folders, we need to delete all objects with this prefix
            let continuationToken: string | undefined;
            let deletedCount = 0;

            do {
              // List all objects with this prefix
              const listCommand = new ListObjectsV2Command({
                Bucket: config.mediaBucketName,
                Prefix: key,
                ContinuationToken: continuationToken,
              });
              const listResponse = await s3Client.send(listCommand);

              if (listResponse.Contents && listResponse.Contents.length > 0) {
                // Delete objects in batches (max 1000 per request)
                const objectsToDelete = listResponse.Contents
                  .filter(obj => obj.Key)
                  .map(obj => ({ Key: obj.Key! }));

                if (objectsToDelete.length > 0) {
                  const deleteCommand = new DeleteObjectsCommand({
                    Bucket: config.mediaBucketName,
                    Delete: { Objects: objectsToDelete },
                  });
                  await s3Client.send(deleteCommand);
                  deletedCount += objectsToDelete.length;
                }
              }

              continuationToken = listResponse.NextContinuationToken;
            } while (continuationToken);

            messageApi.success(`Deleted folder and ${deletedCount} object(s)`);
          } else {
            // For single files, just delete the object
            const command = new DeleteObjectCommand({
              Bucket: config.mediaBucketName,
              Key: key,
            });
            await s3Client.send(command);
            messageApi.success('Deleted successfully');
          }
          loadObjects(false);
        } catch (error) {
          console.error('Failed to delete:', error);
          messageApi.error('Failed to delete');
        }
      },
    });
  };

  const createFolder = async () => {
    if (!s3Client || !config?.mediaBucketName || !newFolderName.trim()) return;

    try {
      const folderKey = `${currentPrefix}${newFolderName.trim()}/`;
      const command = new PutObjectCommand({
        Bucket: config.mediaBucketName,
        Key: folderKey,
        Body: '',
      });
      await s3Client.send(command);
      messageApi.success('Folder created');
      setNewFolderModalVisible(false);
      setNewFolderName('');
      loadObjects(false);
    } catch (error) {
      console.error('Failed to create folder:', error);
      messageApi.error('Failed to create folder');
    }
  };

  // Helper to upload a single file and update progress
  const uploadSingleFile = async (
    file: File,
    relativePath: string,
    uploadId: string
  ): Promise<void> => {
    if (!s3Client || !config?.mediaBucketName) {
      throw new Error('S3 client not initialized');
    }

    const key = `${currentPrefix}${relativePath}`;

    const upload = new S3Upload({
      client: s3Client,
      params: {
        Bucket: config.mediaBucketName,
        Key: key,
        Body: file,
        ContentType: file.type || 'application/octet-stream',
      },
      leavePartsOnError: false,
    });

    upload.on('httpUploadProgress', (progress) => {
      if (progress.loaded && progress.total) {
        const percent = Math.round((progress.loaded / progress.total) * 100);
        setUploadQueue(prev => prev.map(item => 
          item.id === uploadId ? { ...item, progress: percent } : item
        ));
      }
    });

    await upload.done();
  };

  // Process upload queue
  const processUploadQueue = useCallback(async (files: { file: File; path: string }[]) => {
    if (!s3Client || !config?.mediaBucketName || files.length === 0) return;

    // Filter out files that are already being uploaded (deduplicate)
    const newFiles = files.filter(f => {
      const key = `${currentPrefix}${f.path}`;
      if (uploadedPathsRef.current.has(key)) {
        return false;
      }
      uploadedPathsRef.current.add(key);
      return true;
    });

    if (newFiles.length === 0) return;

    // Create upload items
    const newItems: UploadItem[] = newFiles.map((f, index) => ({
      id: `${Date.now()}-${index}`,
      name: f.file.name,
      path: f.path,
      size: f.file.size,
      status: 'pending' as const,
      progress: 0,
    }));

    setUploadQueue(prev => [...prev, ...newItems]);

    // Process uploads sequentially
    for (let i = 0; i < newFiles.length; i++) {
      const { file, path } = newFiles[i];
      const uploadId = newItems[i].id;

      setUploadQueue(prev => prev.map(item => 
        item.id === uploadId ? { ...item, status: 'uploading' } : item
      ));

      try {
        await uploadSingleFile(file, path, uploadId);
        setUploadQueue(prev => prev.map(item => 
          item.id === uploadId ? { ...item, status: 'success', progress: 100 } : item
        ));
      } catch (error) {
        console.error('Upload failed:', error);
        setUploadQueue(prev => prev.map(item => 
          item.id === uploadId ? { 
            ...item, 
            status: 'error', 
            error: error instanceof Error ? error.message : 'Upload failed' 
          } : item
        ));
      }

      // Remove from tracking set after completion
      const key = `${currentPrefix}${path}`;
      uploadedPathsRef.current.delete(key);
    }

    // Refresh the file list
    loadObjects(false);

    // Clear completed uploads after a delay
    setTimeout(() => {
      setUploadQueue(prev => prev.filter(item => item.status !== 'success'));
    }, 3000);
  }, [s3Client, config?.mediaBucketName, currentPrefix, loadObjects]);

  // Recursively read directory entries
  const readDirectoryEntries = async (entry: FileSystemDirectoryEntry, basePath: string = ''): Promise<{ file: File; path: string }[]> => {
    const files: { file: File; path: string }[] = [];
    const reader = entry.createReader();
    
    const readEntries = (): Promise<FileSystemEntry[]> => {
      return new Promise((resolve, reject) => {
        reader.readEntries(resolve, reject);
      });
    };

    let entries: FileSystemEntry[] = [];
    let batch: FileSystemEntry[];
    
    // readEntries returns batches, need to call until empty
    do {
      batch = await readEntries();
      entries = entries.concat(batch);
    } while (batch.length > 0);

    for (const childEntry of entries) {
      const childPath = basePath ? `${basePath}/${childEntry.name}` : childEntry.name;
      
      if (childEntry.isFile) {
        const fileEntry = childEntry as FileSystemFileEntry;
        const file = await new Promise<File>((resolve, reject) => {
          fileEntry.file(resolve, reject);
        });
        files.push({ file, path: childPath });
      } else if (childEntry.isDirectory) {
        const subFiles = await readDirectoryEntries(childEntry as FileSystemDirectoryEntry, childPath);
        files.push(...subFiles);
      }
    }

    return files;
  };

  // Handle drag and drop
  const handleDrop = useCallback(async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    if (!s3Client || !config?.mediaBucketName) {
      messageApi.error('S3 client not initialized');
      return;
    }

    const items = e.dataTransfer.items;
    
    // IMPORTANT: Collect all entries SYNCHRONOUSLY first!
    // DataTransfer.items becomes invalid after any async operation
    const entries: FileSystemEntry[] = [];
    for (let i = 0; i < items.length; i++) {
      const entry = items[i].webkitGetAsEntry?.();
      if (entry) {
        entries.push(entry);
      }
    }

    // Now process entries asynchronously
    const filesToUpload: { file: File; path: string }[] = [];
    for (const entry of entries) {
      if (entry.isFile) {
        const fileEntry = entry as FileSystemFileEntry;
        const file = await new Promise<File>((resolve, reject) => {
          fileEntry.file(resolve, reject);
        });
        filesToUpload.push({ file, path: file.name });
      } else if (entry.isDirectory) {
        const dirFiles = await readDirectoryEntries(entry as FileSystemDirectoryEntry, entry.name);
        filesToUpload.push(...dirFiles);
      }
    }

    if (filesToUpload.length > 0) {
      messageApi.info(`Uploading ${filesToUpload.length} file(s)...`);
      processUploadQueue(filesToUpload);
    }
  }, [s3Client, config?.mediaBucketName, messageApi, processUploadQueue]);

  const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    // Only set dragging to false if we're leaving the drop zone entirely
    if (dropZoneRef.current && !dropZoneRef.current.contains(e.relatedTarget as Node)) {
      setIsDragging(false);
    }
  }, []);

  const uploadProps: UploadProps = {
    name: 'file',
    multiple: true,
    directory: true,
    showUploadList: false,
    beforeUpload: () => false, // Prevent auto upload
    onChange: (info) => {
      const files = info.fileList
        .filter(f => f.originFileObj)
        .map(f => {
          const file = f.originFileObj as File & { webkitRelativePath?: string };
          return {
            file,
            path: file.webkitRelativePath || file.name,
          };
        });
      
      if (files.length > 0) {
        processUploadQueue(files);
      }
    },
  };

  const fileUploadProps: UploadProps = {
    name: 'file',
    multiple: true,
    showUploadList: false,
    beforeUpload: () => false,
    onChange: (info) => {
      const files = info.fileList
        .filter(f => f.originFileObj)
        .map(f => ({
          file: f.originFileObj as File,
          path: f.name,
        }));
      
      if (files.length > 0) {
        processUploadQueue(files);
      }
    },
  };

  const formatFileSize = (bytes?: number) => {
    if (bytes === undefined) return '-';
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const columns = [
    {
      title: 'Name',
      dataIndex: 'name',
      key: 'name',
      render: (name: string, record: S3Object) => (
        <Space>
          {record.isFolder ? <FolderOutlined style={{ color: '#faad14' }} /> : <FileOutlined />}
          {record.isFolder ? (
            <a onClick={() => navigateToFolder(record.key)}>{name}</a>
          ) : (
            <span>{name}</span>
          )}
        </Space>
      ),
    },
    {
      title: 'Size',
      dataIndex: 'size',
      key: 'size',
      width: 120,
      render: (size: number | undefined, record: S3Object) => 
        record.isFolder ? '-' : formatFileSize(size),
    },
    {
      title: 'Last Modified',
      dataIndex: 'lastModified',
      key: 'lastModified',
      width: 200,
      render: (date: Date | undefined) => 
        date ? new Date(date).toLocaleString() : '-',
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 150,
      render: (_: any, record: S3Object) => (
        <Space>
          {!record.isFolder && (
            <Button
              type="text"
              size="small"
              icon={<DownloadOutlined />}
              onClick={() => downloadFile(record.key, record.name)}
            />
          )}
          <Button
            type="text"
            size="small"
            danger
            icon={<DeleteOutlined />}
            onClick={() => deleteObject(record.key, record.isFolder)}
          />
        </Space>
      ),
    },
  ];

  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    messageApi.success(`${label} copied to clipboard`);
  };

  const watchfolderConfigItems = [
    { label: 'User Pool ID', value: config?.cognitoUserPoolId },
    { label: 'Client ID', value: config?.cognitoClientId },
    { label: 'Identity Pool ID', value: config?.identityPoolId },
    { label: 'Bucket Name', value: config?.mediaBucketName },
    { label: 'Region', value: config?.region },
  ];

  // Build breadcrumb items
  const breadcrumbItems = [
    { href: '/dashboard', title: <><HomeOutlined /> Dashboard</> },
    { title: 'Storage' },
    { title: currentPrefix ? <a onClick={() => setCurrentPrefix('')}>Buckets</a> : 'Buckets' },
  ];

  if (currentPrefix) {
    const parts = currentPrefix.split('/').filter(Boolean);
    parts.forEach((part, index) => {
      const prefix = parts.slice(0, index + 1).join('/') + '/';
      if (index === parts.length - 1) {
        breadcrumbItems.push({ title: part });
      } else {
        breadcrumbItems.push({ 
          title: <a onClick={() => setCurrentPrefix(prefix)}>{part}</a> 
        });
      }
    });
  }

  return (
    <AppLayoutAntd
      user={user}
      isAdmin={isAdmin}
      config={config}
      onSignOut={onSignOut}
      onChangePassword={onChangePassword}
    >
      {contextHolder}
      <Breadcrumb items={breadcrumbItems} style={{ marginBottom: 16 }} />

      <Space direction="vertical" size="large" style={{ width: '100%' }}>
        {configError ? (
          <Alert
            message="Configuration Required"
            description={configError}
            type="warning"
            showIcon
          />
        ) : (
          <>
            {/* S3 Browser Card */}
            <Card
              title={
                <Space>
                  <CloudUploadOutlined />
                  <span>Media Bucket: {config?.mediaBucketName || 'Not configured'}</span>
                </Space>
              }
              extra={
                <Space>
                  <Button
                    icon={<FolderAddOutlined />}
                    onClick={() => setNewFolderModalVisible(true)}
                  >
                    New Folder
                  </Button>
                  <Button
                    icon={<ReloadOutlined />}
                    onClick={() => loadObjects(false)}
                    loading={loading}
                  >
                    Refresh
                  </Button>
                </Space>
              }
            >
              {/* Upload area - supports files and folders via drag and drop */}
              <div
                ref={dropZoneRef}
                onDrop={handleDrop}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                style={{
                  border: `2px dashed ${isDragging ? '#1890ff' : '#d9d9d9'}`,
                  borderRadius: 8,
                  padding: 24,
                  textAlign: 'center',
                  marginBottom: 16,
                  backgroundColor: isDragging ? '#e6f7ff' : 'transparent',
                  transition: 'all 0.3s',
                  cursor: 'pointer',
                }}
              >
                <p style={{ fontSize: 48, color: '#1890ff', margin: 0 }}>
                  <InboxOutlined />
                </p>
                <p style={{ fontSize: 16, margin: '8px 0' }}>
                  {isDragging ? 'Drop files or folders here' : 'Drag and drop files or folders here'}
                </p>
                <p style={{ color: '#888' }}>
                  Or use the buttons below to select files or folders
                </p>
              </div>

              {/* Action buttons row */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                <Space>
                  <Upload {...fileUploadProps}>
                    <Button icon={<CloudUploadOutlined />}>Upload Files</Button>
                  </Upload>
                  <Upload {...uploadProps}>
                    <Button icon={<FolderOutlined />}>Upload Folder</Button>
                  </Upload>
                </Space>
                {currentPrefix && (
                  <Button
                    icon={<ArrowLeftOutlined />}
                    onClick={navigateUp}
                  >
                    Back
                  </Button>
                )}
              </div>

              {/* Upload progress list */}
              {uploadQueue.length > 0 && (
                <Card size="small" title="Upload Progress" style={{ marginBottom: 16 }}>
                  <List
                    size="small"
                    dataSource={uploadQueue}
                    renderItem={(item) => (
                      <List.Item>
                        <div style={{ width: '100%' }}>
                          <Space style={{ width: '100%', justifyContent: 'space-between' }}>
                            <Space>
                              {item.status === 'uploading' && <LoadingOutlined spin />}
                              {item.status === 'success' && <CheckCircleOutlined style={{ color: '#52c41a' }} />}
                              {item.status === 'error' && <CloseCircleOutlined style={{ color: '#ff4d4f' }} />}
                              {item.status === 'pending' && <FileOutlined />}
                              <span style={{ maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {item.path}
                              </span>
                            </Space>
                            <Tag color={
                              item.status === 'success' ? 'success' :
                              item.status === 'error' ? 'error' :
                              item.status === 'uploading' ? 'processing' : 'default'
                            }>
                              {item.status === 'uploading' ? `${item.progress}%` : item.status}
                            </Tag>
                          </Space>
                          {item.status === 'uploading' && (
                            <Progress percent={item.progress} size="small" showInfo={false} />
                          )}
                          {item.error && (
                            <Typography.Text type="danger" style={{ fontSize: 12 }}>{item.error}</Typography.Text>
                          )}
                        </div>
                      </List.Item>
                    )}
                  />
                </Card>
              )}

              {/* File/Folder table */}
              <Table
                columns={columns}
                dataSource={objects}
                rowKey="key"
                loading={loading}
                pagination={false}
                locale={{
                  emptyText: (
                    <Empty
                      image={Empty.PRESENTED_IMAGE_SIMPLE}
                      description="No files or folders"
                    />
                  ),
                }}
              />
              
              {/* Load More / Pagination info */}
              {(hasMore || totalLoaded > 0) && (
                <div style={{ marginTop: 16, textAlign: 'center' }}>
                  <Space>
                    <Text type="secondary">
                      Showing {objects.length} item(s)
                    </Text>
                    {hasMore && (
                      <Button
                        onClick={() => loadObjects(true)}
                        loading={loading}
                      >
                        Load More
                      </Button>
                    )}
                  </Space>
                </div>
              )}
            </Card>

            {/* S3 Watchfolder Configuration - Collapsible */}
            <Collapse
              items={[
                {
                  key: 'watchfolder',
                  label: (
                    <Space>
                      <SettingOutlined />
                      <span>S3 Watchfolder Configuration</span>
                    </Space>
                  ),
                  children: (
                    <>
                      <Paragraph type="secondary">
                        Use the S3 Watchfolder desktop application to automatically sync files from your local
                        computer to this S3 bucket. Download the app and configure it with the settings below.
                      </Paragraph>

                      <Descriptions bordered column={1} size="small">
                        {watchfolderConfigItems.map((item) => (
                          <Descriptions.Item
                            key={item.label}
                            label={item.label}
                            labelStyle={{ width: 150 }}
                          >
                            <Space>
                              <Text code>{item.value || 'Not configured'}</Text>
                              {item.value && (
                                <Button
                                  type="text"
                                  size="small"
                                  icon={<CopyOutlined />}
                                  onClick={() => copyToClipboard(item.value!, item.label)}
                                />
                              )}
                            </Space>
                          </Descriptions.Item>
                        ))}
                      </Descriptions>

                      <Space style={{ marginTop: 16 }}>
                        <Button
                          type="primary"
                          icon={<CopyOutlined />}
                          onClick={() => {
                            const configJson = JSON.stringify(
                              {
                                userPoolId: config?.cognitoUserPoolId,
                                clientId: config?.cognitoClientId,
                                identityPoolId: config?.identityPoolId,
                                bucketName: config?.mediaBucketName,
                                region: config?.region,
                              },
                              null,
                              2
                            );
                            copyToClipboard(configJson, 'Configuration');
                          }}
                        >
                          Copy All Config
                        </Button>
                        <Button
                          icon={<DownloadOutlined />}
                          onClick={() => {
                            const configJson = JSON.stringify(
                              {
                                userPoolId: config?.cognitoUserPoolId,
                                clientId: config?.cognitoClientId,
                                identityPoolId: config?.identityPoolId,
                                bucketName: config?.mediaBucketName,
                                region: config?.region,
                              },
                              null,
                              2
                            );
                            const blob = new Blob([configJson], { type: 'application/json' });
                            const url = URL.createObjectURL(blob);
                            const link = document.createElement('a');
                            link.href = url;
                            link.download = 's3-watchfolder-config.json';
                            document.body.appendChild(link);
                            link.click();
                            document.body.removeChild(link);
                            URL.revokeObjectURL(url);
                            messageApi.success('Configuration file downloaded');
                          }}
                        >
                          Download Config File
                        </Button>
                      </Space>
                    </>
                  ),
                },
              ]}
            />
          </>
        )}
      </Space>

      {/* New Folder Modal */}
      <Modal
        title="Create New Folder"
        open={newFolderModalVisible}
        onOk={createFolder}
        onCancel={() => {
          setNewFolderModalVisible(false);
          setNewFolderName('');
        }}
        okText="Create"
      >
        <Input
          placeholder="Folder name"
          value={newFolderName}
          onChange={(e) => setNewFolderName(e.target.value)}
          onPressEnter={createFolder}
        />
      </Modal>
    </AppLayoutAntd>
  );
};

export default BucketsAntd;
