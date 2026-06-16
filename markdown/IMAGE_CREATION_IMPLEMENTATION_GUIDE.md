# Image Creation Feature - Implementation Guide

## Phase 1: Database Schema and Infrastructure

### 1.1 DynamoDB Table Schema Extension

The existing `workstation-images` table will be extended to support both AMIs and Image Builder pipelines using a unified schema:

```typescript
// Add to existing table structure
interface ImageRecord {
  // Primary Key Structure
  PK: string;           // "ami-12345678" | "pipeline-uuid-1234"
  SK: string;           // "IMAGE" | "PIPELINE"
  entityType: "AMI" | "PIPELINE";
  
  // Common fields
  name: string;
  description?: string;
  platform: "windows" | "linux";
  createdAt: string;
  updatedAt: string;
  
  // AMI-specific fields (when entityType = "AMI")
  amiId?: string;
  state?: string;
  owner?: string;
  architecture?: string;
  virtualizationType?: string;
  
  // Pipeline-specific fields (when entityType = "PIPELINE")
  pipelineId?: string;
  pipelineArn?: string;
  imageRecipeArn?: string;
  infrastructureConfigArn?: string;
  distributionConfigArn?: string;
  status?: "CREATING" | "BUILDING" | "COMPLETED" | "FAILED";
  baseImageId?: string;
  components?: Component[];
  buildProgress?: BuildProgress;
}

interface Component {
  componentArn: string;
  name: string;
  type: "SOFTWARE_LIBRARY" | "CUSTOM_SCRIPT" | "USER_UPLOAD";
  s3Uri?: string;
  script?: string;
}

interface BuildProgress {
  currentStep: string;
  totalSteps: number;
  completedSteps: number;
  lastUpdated: string;
  executionId?: string;
}
```

### 1.2 S3 Bucket for User Uploads

Add to your CDK stack (pass acronym from app.ts):

```typescript
// In infrastructure-stack.ts or new image-builder-stack.ts
// Assuming acronym and pascalCaseName are passed as props from App.tsx
const imageBuilderUploadsBucket = new s3.Bucket(this, 'ImageBuilderUploads', {
  bucketName: `${props.acronym.toLowerCase()}-image-builder-uploads-${this.account}-${this.region}`,
  encryption: s3.BucketEncryption.S3_MANAGED,
  blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
  lifecycleRules: [
    {
      id: 'DeleteOldUploads',
      expiration: cdk.Duration.days(30),
      abortIncompleteMultipartUploadAfter: cdk.Duration.days(7)
    }
  ],
  cors: [
    {
      allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.POST, s3.HttpMethods.PUT],
      allowedOrigins: ['*'], // Restrict this in production
      allowedHeaders: ['*'],
      maxAge: 3000
    }
  ]
});
```

### 1.3 IAM Roles for Image Builder

```typescript
// Image Builder Service Role
const imageBuilderServiceRole = new iam.Role(this, 'ImageBuilderServiceRole', {
  assumedBy: new iam.ServicePrincipal('imagebuilder.amazonaws.com'),
  managedPolicies: [
    iam.ManagedPolicy.fromAwsManagedPolicyName('EC2InstanceProfileForImageBuilder')
  ],
  inlinePolicies: {
    S3Access: new iam.PolicyDocument({
      statements: [
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ['s3:GetObject', 's3:ListBucket'],
          resources: [
            imageBuilderUploadsBucket.bucketArn,
            `${imageBuilderUploadsBucket.bucketArn}/*`
          ]
        })
      ]
    })
  }
});

// Instance Profile for Build Instances
const imageBuilderInstanceProfile = new iam.InstanceProfile(this, 'ImageBuilderInstanceProfile', {
  roles: [imageBuilderServiceRole]
});
```

## Phase 2: Backend Implementation

### 2.1 Enhanced image-manager.js

Add these new functions to the existing Lambda:

```javascript
// Add to existing image-manager.js

const { ImagebuilderClient, CreateImagePipelineCommand, CreateImageRecipeCommand, 
        CreateInfrastructureConfigurationCommand, CreateDistributionConfigurationCommand,
        StartImagePipelineExecutionCommand, GetImagePipelineCommand } = require('@aws-sdk/client-imagebuilder');
const { v4: uuidv4 } = require('uuid');

const imageBuilderClient = new ImagebuilderClient({ region: process.env.AWS_REGION });

// Add to the main handler switch statement
case 'POST':
  if (path === '/images') {
    return await createImage(JSON.parse(body), event);
  } else if (path === '/images/create-pipeline') {
    return await createImagePipeline(JSON.parse(body), event);
  }
  break;
case 'GET':
  if (path.startsWith('/images/pipelines/') && path.endsWith('/status')) {
    const pipelineId = path.split('/')[3];
    return await getPipelineStatus(pipelineId);
  }
  break;

async function createImagePipeline(pipelineData, event) {
  const { name, description, baseImageId, instanceType, components, schedule } = pipelineData;
  const pipelineId = uuidv4();
  
  try {
    // 1. Create Infrastructure Configuration
    const infraConfig = await imageBuilderClient.send(new CreateInfrastructureConfigurationCommand({
      name: `${name}-infra-${pipelineId.substring(0, 8)}`,
      instanceProfileName: process.env.IMAGE_BUILDER_INSTANCE_PROFILE,
      instanceTypes: [instanceType || 'm5.large'],
      subnetId: process.env.BUILD_SUBNET_ID,
      securityGroupIds: [process.env.BUILD_SECURITY_GROUP_ID],
      terminateInstanceOnFailure: true,
      snsTopicArn: process.env.IMAGE_BUILDER_SNS_TOPIC
    }));

    // 2. Create Distribution Configuration
    const distConfig = await imageBuilderClient.send(new CreateDistributionConfigurationCommand({
      name: `${name}-dist-${pipelineId.substring(0, 8)}`,
      distributions: [
        {
          region: process.env.AWS_REGION,
          amiDistributionConfiguration: {
            name: `${name}-{{imagebuilder:buildDate}}`,
            description: description,
            amiTags: {
              'CreatedBy': props.pascalCaseName, // Passed from App.tsx
              'PipelineId': pipelineId,
              'BaseImage': baseImageId
            }
          }
        }
      ]
    }));

    // 3. Create Custom Components (if any)
    const componentArns = [];
    for (const component of components) {
      if (component.type === 'CUSTOM_SCRIPT' || component.type === 'USER_UPLOAD') {
        const componentArn = await createCustomComponent(component, pipelineId);
        componentArns.push({ componentArn });
      } else {
        // Use existing component ARN from software library
        componentArns.push({ componentArn: component.componentArn });
      }
    }

    // 4. Create Image Recipe
    const imageRecipe = await imageBuilderClient.send(new CreateImageRecipeCommand({
      name: `${name}-recipe-${pipelineId.substring(0, 8)}`,
      version: '1.0.0',
      parentImage: baseImageId,
      components: componentArns,
      description: description
    }));

    // 5. Create Image Pipeline
    const pipeline = await imageBuilderClient.send(new CreateImagePipelineCommand({
      name: `${name}-pipeline-${pipelineId.substring(0, 8)}`,
      description: description,
      imageRecipeArn: imageRecipe.imageRecipeArn,
      infrastructureConfigurationArn: infraConfig.infrastructureConfigurationArn,
      distributionConfigurationArn: distConfig.distributionConfigurationArn,
      status: 'ENABLED',
      enhancedImageMetadataEnabled: true,
      schedule: schedule?.enabled ? {
        scheduleExpression: schedule.expression,
        pipelineExecutionStartCondition: 'EXPRESSION_MATCH_AND_DEPENDENCY_UPDATES_AVAILABLE'
      } : undefined
    }));

    // 6. Store pipeline info in DynamoDB
    await dynamoClient.send(new PutItemCommand({
      TableName: process.env.IMAGES_TABLE_NAME,
      Item: {
        PK: { S: pipelineId },
        SK: { S: 'PIPELINE' },
        entityType: { S: 'PIPELINE' },
        pipelineId: { S: pipelineId },
        pipelineArn: { S: pipeline.imagePipelineArn },
        imageRecipeArn: { S: imageRecipe.imageRecipeArn },
        infrastructureConfigurationArn: { S: infraConfig.infrastructureConfigurationArn },
        distributionConfigurationArn: { S: distConfig.distributionConfigurationArn },
        name: { S: name },
        description: { S: description || '' },
        platform: { S: 'windows' }, // Detect from baseImageId
        baseImageId: { S: baseImageId },
        status: { S: 'CREATED' },
        components: { S: JSON.stringify(components) },
        createdAt: { S: new Date().toISOString() },
        updatedAt: { S: new Date().toISOString() }
      }
    }));

    return {
      statusCode: 201,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
      body: JSON.stringify({
        message: 'Pipeline created successfully',
        pipelineId,
        pipelineArn: pipeline.imagePipelineArn
      })
    };
  } catch (error) {
    console.error('Error creating pipeline:', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
      body: JSON.stringify({ error: 'Failed to create pipeline: ' + error.message })
    };
  }
}

async function createCustomComponent(component, pipelineId) {
  let componentDocument;
  
  if (component.type === 'CUSTOM_SCRIPT') {
    componentDocument = {
      name: component.name,
      description: `Custom component for ${component.name}`,
      schemaVersion: '1.0',
      phases: [
        {
          name: 'build',
          steps: [
            {
              name: 'ExecuteCustomScript',
              action: 'ExecutePowerShell',
              inputs: {
                commands: [component.script]
              }
            }
          ]
        }
      ]
    };
  } else if (component.type === 'USER_UPLOAD') {
    componentDocument = {
      name: component.name,
      description: `Install ${component.name} from uploaded file`,
      schemaVersion: '1.0',
      phases: [
        {
          name: 'build',
          steps: [
            {
              name: 'DownloadInstaller',
              action: 'S3Download',
              inputs: {
                source: component.s3Uri,
                destination: 'C:\\temp\\installer.exe'
              }
            },
            {
              name: 'InstallSoftware',
              action: 'ExecutePowerShell',
              inputs: {
                commands: [
                  component.installScript || 'Start-Process -FilePath "C:\\temp\\installer.exe" -ArgumentList "/S" -Wait'
                ]
              }
            }
          ]
        }
      ]
    };
  }

  const componentResult = await imageBuilderClient.send(new CreateComponentCommand({
    name: `${component.name}-${pipelineId.substring(0, 8)}`,
    version: '1.0.0',
    platform: 'Windows',
    data: JSON.stringify(componentDocument)
  }));

  return componentResult.componentBuildVersionArn;
}

async function getPipelineStatus(pipelineId) {
  try {
    // Get pipeline info from DynamoDB
    const dbResult = await dynamoClient.send(new GetItemCommand({
      TableName: process.env.IMAGES_TABLE_NAME,
      Key: {
        PK: { S: pipelineId },
        SK: { S: 'PIPELINE' }
      }
    }));

    if (!dbResult.Item) {
      return {
        statusCode: 404,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
        body: JSON.stringify({ error: 'Pipeline not found' })
      };
    }

    const pipelineArn = dbResult.Item.pipelineArn.S;
    
    // Get current status from Image Builder
    const pipelineInfo = await imageBuilderClient.send(new GetImagePipelineCommand({
      imagePipelineArn: pipelineArn
    }));

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
      body: JSON.stringify({
        pipelineId,
        status: dbResult.Item.status.S,
        name: dbResult.Item.name.S,
        description: dbResult.Item.description.S,
        buildProgress: dbResult.Item.buildProgress ? JSON.parse(dbResult.Item.buildProgress.S) : null,
        pipelineInfo: pipelineInfo.imagePipeline
      })
    };
  } catch (error) {
    console.error('Error getting pipeline status:', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
      body: JSON.stringify({ error: 'Failed to get pipeline status' })
    };
  }
}
```

### 2.2 EventBridge Integration

Add EventBridge rules to monitor Image Builder events:

```typescript
// In eventbridge-stack.ts or new image-builder-stack.ts
const imageBuilderEventRule = new events.Rule(this, 'ImageBuilderEventRule', {
  eventPattern: {
    source: ['aws.imagebuilder'],
    detailType: [
      'EC2 Image Builder Image State Change',
      'EC2 Image Builder Image Recipe State Change',
      'EC2 Image Builder Infrastructure Configuration State Change'
    ]
  }
});

imageBuilderEventRule.addTarget(new targets.LambdaFunction(imageBuilderEventHandler));
```

## Phase 3: Frontend Implementation

### 3.1 Create ImageCreation.tsx Page

```typescript
// frontend/src/pages/ImageCreation.tsx
import React, { useState, useEffect } from 'react';
import {
  AppLayout,
  ContentLayout,
  Header,
  SpaceBetween,
  Button,
  Form,
  FormField,
  Input,
  Textarea,
  Select,
  Container,
  Grid,
  Cards,
  Box,
  Alert,
  ProgressBar,
  Modal,
  FileUpload
} from '@cloudscape-design/components';
import Navigation from '../components/Navigation';
import { apiCall } from '../utils/api';

interface SoftwareComponent {
  id: string;
  name: string;
  category: string;
  description: string;
  platform: string;
  componentArn: string;
  estimatedInstallTime: string;
  diskSpaceRequired: string;
}

interface PipelineComponent {
  type: 'SOFTWARE_LIBRARY' | 'CUSTOM_SCRIPT' | 'USER_UPLOAD';
  name: string;
  componentArn?: string;
  script?: string;
  s3Uri?: string;
  installScript?: string;
}

const ImageCreation: React.FC = () => {
  const [pipelineName, setPipelineName] = useState('');
  const [description, setDescription] = useState('');
  const [baseImageId, setBaseImageId] = useState('');
  const [instanceType, setInstanceType] = useState('m5.large');
  const [selectedComponents, setSelectedComponents] = useState<PipelineComponent[]>([]);
  const [softwareLibrary, setSoftwareLibrary] = useState<SoftwareComponent[]>([]);
  const [showCustomScriptModal, setShowCustomScriptModal] = useState(false);
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [customScript, setCustomScript] = useState('');
  const [scriptName, setScriptName] = useState('');
  const [uploadFiles, setUploadFiles] = useState<File[]>([]);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    loadSoftwareLibrary();
  }, []);

  const loadSoftwareLibrary = async () => {
    // Load pre-configured software components
    const library: SoftwareComponent[] = [
      {
        id: 'adobe-creative-suite-2024',
        name: 'Adobe Creative Suite 2024',
        category: 'Media & Design',
        description: 'Complete Adobe Creative Suite including Photoshop, Premiere Pro, After Effects',
        platform: 'windows',
        componentArn: 'arn:aws:imagebuilder:us-east-1:123456789012:component/adobe-cs-2024/1.0.0',
        estimatedInstallTime: '45 minutes',
        diskSpaceRequired: '15 GB'
      },
      {
        id: 'autodesk-maya-2024',
        name: 'Autodesk Maya 2024',
        category: '3D & Animation',
        description: 'Professional 3D modeling and animation software',
        platform: 'windows',
        componentArn: 'arn:aws:imagebuilder:us-east-1:123456789012:component/maya-2024/1.0.0',
        estimatedInstallTime: '30 minutes',
        diskSpaceRequired: '8 GB'
      }
    ];
    setSoftwareLibrary(library);
  };

  const addSoftwareComponent = (software: SoftwareComponent) => {
    const component: PipelineComponent = {
      type: 'SOFTWARE_LIBRARY',
      name: software.name,
      componentArn: software.componentArn
    };
    setSelectedComponents([...selectedComponents, component]);
  };

  const addCustomScript = () => {
    if (scriptName && customScript) {
      const component: PipelineComponent = {
        type: 'CUSTOM_SCRIPT',
        name: scriptName,
        script: customScript
      };
      setSelectedComponents([...selectedComponents, component]);
      setShowCustomScriptModal(false);
      setScriptName('');
      setCustomScript('');
    }
  };

  const createPipeline = async () => {
    setCreating(true);
    try {
      const response = await apiCall('/images/create-pipeline', 'POST', {
        name: pipelineName,
        description,
        baseImageId,
        instanceType,
        components: selectedComponents,
        schedule: { enabled: false }
      });

      if (response.ok) {
        // Navigate to pipeline status page or show success message
        console.log('Pipeline created successfully');
      }
    } catch (error) {
      console.error('Error creating pipeline:', error);
    } finally {
      setCreating(false);
    }
  };

  return (
    <AppLayout
      navigation={<Navigation />}
      content={
        <ContentLayout
          header={
            <Header
              variant="h1"
              description="Create custom AMIs using EC2 Image Builder"
            >
              Create Image Pipeline
            </Header>
          }
        >
          <SpaceBetween direction="vertical" size="l">
            <Container header={<Header variant="h2">Pipeline Configuration</Header>}>
              <SpaceBetween direction="vertical" size="m">
                <Grid gridDefinition={[{ colspan: 6 }, { colspan: 6 }]}>
                  <FormField label="Pipeline Name" constraintText="Enter a descriptive name">
                    <Input
                      value={pipelineName}
                      onChange={({ detail }) => setPipelineName(detail.value)}
                      placeholder="e.g., Media Workstation Pipeline"
                    />
                  </FormField>
                  <FormField label="Instance Type" constraintText="Build instance type">
                    <Select
                      selectedOption={{ label: instanceType, value: instanceType }}
                      onChange={({ detail }) => setInstanceType(detail.selectedOption.value!)}
                      options={[
                        { label: 'm5.large', value: 'm5.large' },
                        { label: 'm5.xlarge', value: 'm5.xlarge' },
                        { label: 'm5.2xlarge', value: 'm5.2xlarge' }
                      ]}
                    />
                  </FormField>
                </Grid>
                <FormField label="Description" constraintText="Optional description">
                  <Textarea
                    value={description}
                    onChange={({ detail }) => setDescription(detail.value)}
                    placeholder="Describe what this image will be used for..."
                    rows={3}
                  />
                </FormField>
                <FormField label="Base Image" constraintText="Select the base AMI">
                  <Select
                    selectedOption={baseImageId ? { label: baseImageId, value: baseImageId } : null}
                    onChange={({ detail }) => setBaseImageId(detail.selectedOption.value!)}
                    options={[
                      { label: 'Windows Server 2022 Base', value: 'ami-12345678' },
                      { label: 'Windows Server 2019 Base', value: 'ami-87654321' }
                    ]}
                    placeholder="Choose a base image"
                  />
                </FormField>
              </SpaceBetween>
            </Container>

            <Container header={<Header variant="h2">Software Components</Header>}>
              <SpaceBetween direction="vertical" size="m">
                <Box>
                  <SpaceBetween direction="horizontal" size="s">
                    <Button onClick={() => setShowCustomScriptModal(true)}>
                      Add Custom Script
                    </Button>
                    <Button onClick={() => setShowUploadModal(true)}>
                      Upload Software
                    </Button>
                  </SpaceBetween>
                </Box>

                <Cards
                  cardDefinition={{
                    header: item => item.name,
                    sections: [
                      {
                        id: 'description',
                        content: item => item.description
                      },
                      {
                        id: 'details',
                        content: item => (
                          <SpaceBetween direction="vertical" size="xs">
                            <Box variant="small">Category: {item.category}</Box>
                            <Box variant="small">Install Time: {item.estimatedInstallTime}</Box>
                            <Box variant="small">Disk Space: {item.diskSpaceRequired}</Box>
                          </SpaceBetween>
                        )
                      }
                    ]
                  }}
                  cardsPerRow={[{ cards: 1 }, { minWidth: 500, cards: 2 }]}
                  items={softwareLibrary}
                  loadingText="Loading software library"
                  empty={
                    <Box textAlign="center" color="inherit">
                      <b>No software available</b>
                      <Box variant="p" color="inherit">
                        No software components found in the library.
                      </Box>
                    </Box>
                  }
                  header={<Header>Available Software</Header>}
                />
              </SpaceBetween>
            </Container>

            <Container header={<Header variant="h2">Selected Components</Header>}>
              {selectedComponents.length === 0 ? (
                <Box textAlign="center" color="inherit">
                  <b>No components selected</b>
                  <Box variant="p" color="inherit">
                    Add software components or custom scripts to your pipeline.
                  </Box>
                </Box>
              ) : (
                <SpaceBetween direction="vertical" size="s">
                  {selectedComponents.map((component, index) => (
                    <Box key={index} padding="s" color="text-body-secondary">
                      <SpaceBetween direction="horizontal" size="s">
                        <Box variant="strong">{component.name}</Box>
                        <Box variant="small">({component.type})</Box>
                        <Button
                          variant="link"
                          onClick={() => {
                            const newComponents = [...selectedComponents];
                            newComponents.splice(index, 1);
                            setSelectedComponents(newComponents);
                          }}
                        >
                          Remove
                        </Button>
                      </SpaceBetween>
                    </Box>
                  ))}
                </SpaceBetween>
              )}
            </Container>

            <Box float="right">
              <SpaceBetween direction="horizontal" size="s">
                <Button variant="link">Cancel</Button>
                <Button
                  variant="primary"
                  loading={creating}
                  disabled={!pipelineName || !baseImageId}
                  onClick={createPipeline}
                >
                  Create Pipeline
                </Button>
              </SpaceBetween>
            </Box>
          </SpaceBetween>

          {/* Custom Script Modal */}
          <Modal
            visible={showCustomScriptModal}
            onDismiss={() => setShowCustomScriptModal(false)}
            header="Add Custom Script"
            footer={
              <Box float="right">
                <SpaceBetween direction="horizontal" size="s">
                  <Button variant="link" onClick={() => setShowCustomScriptModal(false)}>
                    Cancel
                  </Button>
                  <Button variant="primary" onClick={addCustomScript}>
                    Add Script
                  </Button>
                </SpaceBetween>
              </Box>
            }
          >
            <SpaceBetween direction="vertical" size="m">
              <FormField label="Script Name">
                <Input
                  value={scriptName}
                  onChange={({ detail }) => setScriptName(detail.value)}
                  placeholder="e.g., Configure System Settings"
                />
              </FormField>
              <FormField label="PowerShell Script">
                <Textarea
                  value={customScript}
                  onChange={({ detail }) => setCustomScript(detail.value)}
                  placeholder="Enter your PowerShell script here..."
                  rows={10}
                />
              </FormField>
            </SpaceBetween>
          </Modal>
        </ContentLayout>
      }
    />
  );
};

export default ImageCreation;
```

### 3.2 Update ImageManagement.tsx

Add the "Create Image" button:

```typescript
// In ImageManagement.tsx, add to the header actions
<SpaceBetween direction="horizontal" size="s">
  <Button
    variant="primary"
    onClick={() => navigate('/image-creation')}
  >
    Create Image
  </Button>
  <Button onClick={() => setShowCreateModal(true)}>
    Import AMI
  </Button>
</SpaceBetween>
```

### 3.3 Add Route Configuration

```typescript
// In App.tsx or your routing configuration
import ImageCreation from './pages/ImageCreation';

// Add to your routes
<Route path="/image-creation" element={<ImageCreation />} />
```

## Next Steps

1. **Review the system design** and provide feedback
2. **Start with Phase 1** - Database and infrastructure setup
3. **Implement Phase 2** - Backend API development
4. **Build Phase 3** - Frontend components
5. **Test end-to-end** functionality

This implementation provides a solid foundation for the Image Creation feature using EC2 Image Builder. The modular approach allows for iterative development and testing.
