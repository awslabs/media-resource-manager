# Image Creation Feature - System Design

## Overview

This document outlines the design and implementation plan for the **Image Creation** feature in the Media Resource Manager application. This feature will enable administrators to create custom AMIs using AWS EC2 Image Builder through an intuitive web interface.

## Architecture Decision: EC2 Image Builder vs Packer

**Selected Solution: AWS EC2 Image Builder**

### Rationale:
- **Native AWS Integration**: Seamless integration with existing AWS services (IAM, S3, SNS, CloudWatch)
- **Managed Service**: No infrastructure to maintain, automatic scaling and patching
- **Security**: Built-in security best practices and compliance features
- **Cost Effective**: Pay-per-use model with no ongoing infrastructure costs
- **Component Ecosystem**: Rich library of pre-built components for common software installations
- **Pipeline Automation**: Built-in scheduling and automation capabilities
- **Monitoring**: Native CloudWatch integration for build monitoring and logging

## System Components

### 1. Frontend Components

#### New Page: ImageCreation.tsx
- **Route**: `/image-creation`
- **Purpose**: Dedicated page for creating EC2 Image Builder pipelines
- **Features**:
  - Pipeline configuration form
  - Component selection interface
  - Software library browser
  - Custom script editor
  - Build progress monitoring

#### Updated Component: ImageManagement.tsx
- **New Button**: "Create Image" action button
- **Navigation**: Routes to `/image-creation` page

### 2. Backend Components

#### Enhanced Lambda: image-manager.js
- **New Endpoint**: `POST /images/create-pipeline`
- **New Endpoint**: `GET /images/pipelines/{pipelineId}/status`
- **New Endpoint**: `POST /images/pipelines/{pipelineId}/execute`

#### New Lambda: image-builder-manager.js
- **Purpose**: Dedicated handler for EC2 Image Builder operations
- **Responsibilities**:
  - Create and manage Image Builder pipelines
  - Create custom components from user scripts
  - Monitor build progress
  - Handle build completion events

### 3. Database Schema

#### Option A: Unified Table (Recommended)
Extend existing `workstation-images` table with new fields:

```json
{
  "PK": "ami-12345678" | "pipeline-uuid-1234",
  "SK": "IMAGE" | "PIPELINE",
  "entityType": "AMI" | "PIPELINE",
  
  // Existing AMI fields
  "amiId": "ami-12345678",
  "name": "Custom Workstation Image",
  "platform": "windows",
  "description": "Custom image with media tools",
  
  // New Pipeline fields
  "pipelineId": "uuid-1234-5678",
  "pipelineArn": "arn:aws:imagebuilder:...",
  "imageRecipeArn": "arn:aws:imagebuilder:...",
  "infrastructureConfigArn": "arn:aws:imagebuilder:...",
  "distributionConfigArn": "arn:aws:imagebuilder:...",
  "status": "CREATING" | "BUILDING" | "COMPLETED" | "FAILED",
  "baseImageId": "ami-base-12345",
  "components": [
    {
      "componentArn": "arn:aws:imagebuilder:...",
      "name": "Adobe Creative Suite",
      "type": "SOFTWARE_LIBRARY" | "CUSTOM_SCRIPT" | "USER_UPLOAD"
    }
  ],
  "buildProgress": {
    "currentStep": "BUILDING",
    "totalSteps": 5,
    "completedSteps": 2,
    "lastUpdated": "2024-01-15T10:30:00Z"
  },
  "createdAt": "2024-01-15T09:00:00Z",
  "updatedAt": "2024-01-15T10:30:00Z"
}
```

### 4. AWS Infrastructure

#### S3 Bucket: User Upload Storage
- **Purpose**: Store user-uploaded software installers
- **Naming**: `{acronym.toLowerCase()}-image-builder-uploads-{accountId}-{region}`
- **Structure**:
  ```
  /uploads/
    /{pipelineId}/
      /software/
        /adobe-creative-suite.exe
        /custom-app.msi
      /scripts/
        /install-custom-app.ps1
        /configure-settings.ps1
  ```

#### IAM Roles and Policies
- **Image Builder Service Role**: Permissions for EC2, S3, CloudWatch, SNS
- **Lambda Execution Role**: Permissions for Image Builder APIs, DynamoDB, S3
- **Instance Profile**: For build instances to access S3 uploads

#### EventBridge Rules
- **Image Builder State Changes**: Monitor pipeline execution status
- **Build Completion**: Trigger AMI registration in DynamoDB

## Implementation Plan

### Phase 1: Core Infrastructure (Week 1)
1. **Database Schema Updates**
   - Extend DynamoDB table with pipeline fields
   - Update GSI for efficient querying
   
2. **S3 Bucket Setup**
   - Create upload bucket with proper permissions
   - Configure lifecycle policies for cleanup
   
3. **IAM Roles and Policies**
   - Create Image Builder service roles
   - Update Lambda execution roles

### Phase 2: Backend API (Week 2)
1. **Enhanced image-manager.js**
   - Add pipeline creation endpoint
   - Add status monitoring endpoint
   - Add pipeline execution endpoint
   
2. **New image-builder-manager.js**
   - Implement Image Builder API calls
   - Handle component creation
   - Process build events

3. **EventBridge Integration**
   - Set up build status monitoring
   - Implement automatic AMI registration

### Phase 3: Frontend Development (Week 3)
1. **ImageCreation.tsx Page**
   - Pipeline configuration form
   - Base image selection
   - Component management interface
   
2. **Software Library Component**
   - Pre-configured software catalog
   - Search and filter functionality
   
3. **Upload Manager Component**
   - File upload interface
   - Progress tracking
   - Validation

### Phase 4: Advanced Features (Week 4)
1. **Custom Script Editor**
   - Syntax highlighting for PowerShell
   - Script validation
   - Template library
   
2. **Build Monitoring**
   - Real-time progress updates
   - Log streaming
   - Error handling and retry logic
   
3. **Testing and Optimization**
   - End-to-end testing
   - Performance optimization
   - Error handling improvements

## API Specifications

### Create Pipeline
```http
POST /images/create-pipeline
Content-Type: application/json

{
  "name": "Custom Media Workstation",
  "description": "Workstation with Adobe Creative Suite and custom tools",
  "baseImageId": "ami-12345678",
  "instanceType": "m5.large",
  "components": [
    {
      "type": "SOFTWARE_LIBRARY",
      "name": "Adobe Creative Suite 2024",
      "componentId": "adobe-cs-2024"
    },
    {
      "type": "USER_UPLOAD",
      "name": "Custom Media Tools",
      "s3Uri": "s3://bucket/uploads/pipeline-123/software/media-tools.exe",
      "installScript": "powershell script content"
    },
    {
      "type": "CUSTOM_SCRIPT",
      "name": "System Configuration",
      "script": "powershell script content"
    }
  ],
  "schedule": {
    "enabled": false,
    "expression": "cron(0 2 * * SUN)"
  }
}
```

### Get Pipeline Status
```http
GET /images/pipelines/{pipelineId}/status

Response:
{
  "pipelineId": "uuid-1234",
  "status": "BUILDING",
  "progress": {
    "currentStep": "Installing Components",
    "totalSteps": 5,
    "completedSteps": 2,
    "percentage": 40
  },
  "buildLogs": [
    {
      "timestamp": "2024-01-15T10:30:00Z",
      "level": "INFO",
      "message": "Starting component installation"
    }
  ],
  "estimatedCompletion": "2024-01-15T11:15:00Z"
}
```

### Execute Pipeline
```http
POST /images/pipelines/{pipelineId}/execute

Response:
{
  "executionId": "exec-5678",
  "status": "STARTED",
  "message": "Pipeline execution initiated"
}
```

## Software Library Design

### Pre-configured Components
```json
{
  "softwareLibrary": [
    {
      "id": "adobe-creative-suite-2024",
      "name": "Adobe Creative Suite 2024",
      "category": "Media & Design",
      "description": "Complete Adobe Creative Suite including Photoshop, Premiere Pro, After Effects",
      "platform": "windows",
      "componentArn": "arn:aws:imagebuilder:us-east-1:123456789012:component/adobe-cs-2024/1.0.0",
      "estimatedInstallTime": "45 minutes",
      "diskSpaceRequired": "15 GB",
      "prerequisites": [".NET Framework 4.8", "Visual C++ Redistributable"]
    },
    {
      "id": "autodesk-maya-2024",
      "name": "Autodesk Maya 2024",
      "category": "3D & Animation",
      "description": "Professional 3D modeling and animation software",
      "platform": "windows",
      "componentArn": "arn:aws:imagebuilder:us-east-1:123456789012:component/maya-2024/1.0.0",
      "estimatedInstallTime": "30 minutes",
      "diskSpaceRequired": "8 GB"
    }
  ]
}
```

## Security Considerations

### Access Control
- **Admin Only**: Image creation restricted to admin users
- **IAM Policies**: Least privilege access for all components
- **S3 Bucket Policies**: Secure upload and access patterns

### Data Protection
- **Encryption**: All S3 uploads encrypted at rest
- **Network Security**: VPC endpoints for Image Builder communication
- **Audit Logging**: CloudTrail logging for all Image Builder operations

### Script Validation
- **PowerShell Execution Policy**: Restricted execution environment
- **Script Scanning**: Basic validation for malicious patterns
- **Sandboxed Execution**: Build instances isolated from production

## Monitoring and Logging

### CloudWatch Metrics
- Pipeline execution duration
- Build success/failure rates
- Component installation times
- Resource utilization during builds

### CloudWatch Logs
- Image Builder execution logs
- Lambda function logs
- Custom application logs

### Alerting
- Build failure notifications
- Long-running build alerts
- Resource quota warnings

## Cost Optimization

### Build Instance Management
- **Automatic Termination**: Instances terminated after build completion
- **Instance Type Selection**: Right-sized instances based on workload
- **Spot Instances**: Use spot instances for non-critical builds

### Storage Optimization
- **S3 Lifecycle Policies**: Automatic cleanup of old uploads
- **AMI Cleanup**: Automated deletion of unused AMIs
- **Log Retention**: Configurable log retention periods

## Testing Strategy

### Unit Tests
- Lambda function logic
- DynamoDB operations
- S3 upload handling

### Integration Tests
- End-to-end pipeline creation
- Component installation verification
- AMI functionality testing

### User Acceptance Tests
- Admin workflow testing
- Error handling scenarios
- Performance benchmarking

## Deployment Strategy

### CDK Stack Updates
- New IAM roles and policies
- S3 bucket creation
- EventBridge rule configuration
- Lambda function updates

### Database Migration
- Schema updates for existing table
- Data migration scripts if needed
- Backward compatibility maintenance

### Frontend Deployment
- New route configuration
- Component library updates
- Asset optimization

## Success Metrics

### Technical Metrics
- Build success rate > 95%
- Average build time < 60 minutes
- API response time < 2 seconds
- Zero security vulnerabilities

### User Experience Metrics
- Time to create first pipeline < 10 minutes
- User satisfaction score > 4.5/5
- Support ticket reduction by 30%
- Feature adoption rate > 80% within 3 months

## Risk Mitigation

### Technical Risks
- **Build Failures**: Comprehensive error handling and retry logic
- **Resource Limits**: Monitoring and alerting for AWS service limits
- **Performance Issues**: Load testing and optimization

### Operational Risks
- **User Training**: Documentation and training materials
- **Support Overhead**: Self-service capabilities and troubleshooting guides
- **Cost Overruns**: Budget monitoring and cost controls

## Future Enhancements

### Phase 2 Features
- **Multi-region Support**: Pipeline replication across regions
- **Template Library**: Shareable pipeline templates
- **Advanced Scheduling**: Complex scheduling patterns
- **Integration Testing**: Automated AMI validation

### Phase 3 Features
- **Container Support**: Docker image building capabilities
- **Version Management**: AMI versioning and rollback
- **Compliance Scanning**: Automated security and compliance checks
- **API Integration**: Third-party software catalog integration

## Conclusion

The Image Creation feature will significantly enhance the Media Resource Manager by providing administrators with a user-friendly interface to create custom AMIs. The use of AWS EC2 Image Builder ensures a robust, scalable, and secure solution that integrates seamlessly with the existing architecture.

The phased implementation approach allows for iterative development and testing, ensuring a high-quality delivery that meets user needs while maintaining system reliability and security.
