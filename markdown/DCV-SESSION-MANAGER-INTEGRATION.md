# DCV Session Manager CLI Integration

This document describes the integration of the NICE DCV Session Manager CLI with AWS Lambda for programmatic session management.

## Overview

The DCV Session Manager CLI integration provides a serverless API for managing DCV sessions on workstation instances. It uses:

- **Lambda Layer**: Contains the DCV Session Manager CLI and its dependencies
- **Lambda Function**: Wraps CLI commands in a REST API
- **API Gateway**: Provides HTTP endpoints for session management

## Architecture

```
Frontend/Client → API Gateway → Lambda Function → DCV Session Manager CLI → DCV Session Manager
```

## Components

### 1. Lambda Layer (`dcv-session-manager-layer.zip`)

Contains:
- DCV Session Manager CLI (`dcvsm`)
- Python dependencies (requests, click, etc.)
- Swagger client for DCV API

### 2. Lambda Function (`dcv-session-manager.js`)

Provides a Node.js wrapper around the CLI with these capabilities:
- Execute CLI commands with proper error handling
- Parse JSON responses
- Handle CORS for web frontend integration

### 3. API Gateway Integration

Exposes REST endpoints:
- `POST /dcv` - Execute DCV Session Manager commands

## Supported Operations

### Describe Sessions
```json
{
  "action": "describe-sessions",
  "serverId": "i-1234567890abcdef0" // optional
}
```

### Create Session
```json
{
  "action": "create-session",
  "serverId": "i-1234567890abcdef0",
  "sessionId": "my-session",
  "sessionType": "console", // or "virtual"
  "owner": "username" // optional
}
```

### Delete Session
```json
{
  "action": "delete-session",
  "serverId": "i-1234567890abcdef0",
  "sessionId": "my-session"
}
```

### Get Connection Data
```json
{
  "action": "get-connection-data",
  "serverId": "i-1234567890abcdef0",
  "sessionId": "my-session"
}
```

### Describe Servers
```json
{
  "action": "describe-servers"
}
```

## Deployment

### Prerequisites

1. DCV Session Manager deployed and accessible
2. Network Load Balancer configured for Session Manager
3. Proper security groups allowing Lambda to reach Session Manager

### Deploy the Stack

```bash
# Build and deploy the DCV Session Manager integration
cdk deploy WorkstationMgmtDcvSM
```

### Environment Variables

The Lambda function requires:
- `DCV_SESSION_MANAGER_ENDPOINT`: HTTPS endpoint of the Session Manager (e.g., `https://dcv-sm-nlb-123.elb.us-east-1.amazonaws.com:8443`)

## Usage Examples

### JavaScript/Node.js
```javascript
const response = await fetch('https://api-gateway-url/prod/dcv', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    action: 'describe-sessions',
    serverId: 'i-1234567890abcdef0'
  })
});

const sessions = await response.json();
console.log(sessions);
```

### Python
```python
import requests

response = requests.post('https://api-gateway-url/prod/dcv', json={
    'action': 'create-session',
    'serverId': 'i-1234567890abcdef0',
    'sessionId': 'my-session',
    'sessionType': 'console'
})

result = response.json()
print(result)
```

### curl
```bash
curl -X POST https://api-gateway-url/prod/dcv \
  -H "Content-Type: application/json" \
  -d '{
    "action": "describe-servers"
  }'
```

## Testing

Use the provided test script:

```bash
node test-dcv-integration.js https://your-api-gateway-url/prod/dcv
```

## Integration with Workstation Management

The DCV Session Manager integration can be used to enhance the workstation management system:

### 1. Automatic Session Creation
When a workstation is started, automatically create a DCV session:

```javascript
// In workstation start function
const sessionResult = await fetch(dcvApiEndpoint, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    action: 'create-session',
    serverId: instanceId,
    sessionId: `session-${userId}`,
    sessionType: 'console',
    owner: userId
  })
});
```

### 2. Session Status Monitoring
Check session status before allowing connections:

```javascript
const sessions = await fetch(dcvApiEndpoint, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    action: 'describe-sessions',
    serverId: instanceId
  })
});
```

### 3. Connection URL Generation
Get connection details for the DCV client:

```javascript
const connectionData = await fetch(dcvApiEndpoint, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    action: 'get-connection-data',
    serverId: instanceId,
    sessionId: sessionId
  })
});
```

## Security Considerations

1. **Network Security**: Ensure Lambda can reach DCV Session Manager through proper VPC configuration
2. **Authentication**: Consider adding API Gateway authorizers for production use
3. **SSL/TLS**: Use HTTPS endpoints and proper certificate validation
4. **IAM Permissions**: Follow least privilege principle for Lambda execution role

## Troubleshooting

### Common Issues

1. **Connection Timeout**: Check security groups and NACLs
2. **SSL Certificate Errors**: Verify Session Manager certificate configuration
3. **Permission Denied**: Ensure Lambda execution role has necessary permissions
4. **CLI Command Failures**: Check DCV Session Manager logs

### Debugging

Enable CloudWatch logs for the Lambda function:

```bash
aws logs tail /aws/lambda/WorkstationMgmtDcvSM-DcvSessionManagerFunction --follow
```

## Performance Considerations

- **Cold Starts**: Lambda layer adds ~1.5MB, consider provisioned concurrency for production
- **Timeout**: CLI commands may take time, adjust Lambda timeout as needed
- **Concurrent Sessions**: Monitor DCV Session Manager capacity

## Future Enhancements

1. **Caching**: Add Redis/ElastiCache for session state caching
2. **WebSocket Support**: Real-time session status updates
3. **Batch Operations**: Support multiple session operations in single request
4. **Metrics**: CloudWatch metrics for session management operations
5. **Step Functions**: Orchestrate complex session lifecycle workflows

## References

- [NICE DCV Session Manager Documentation](https://docs.aws.amazon.com/dcv/latest/sm-admin/)
- [DCV Session Manager CLI Reference](https://docs.aws.amazon.com/dcv/latest/sm-admin/managing-sessions-cli.html)
- [AWS Lambda Layers](https://docs.aws.amazon.com/lambda/latest/dg/configuration-layers.html)
