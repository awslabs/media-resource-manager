// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand, PutCommand, DeleteCommand, ScanCommand } = require('@aws-sdk/lib-dynamodb');
const { ImagebuilderClient, CreateComponentCommand, DeleteComponentCommand, ListImageRecipesCommand, GetImageRecipeCommand, GetComponentCommand } = require('@aws-sdk/client-imagebuilder');
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { STSClient, GetCallerIdentityCommand } = require('@aws-sdk/client-sts');

const dynamoClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const imagebuilderClient = new ImagebuilderClient({ region: process.env.AWS_REGION });
const s3Client = new S3Client({ region: process.env.AWS_REGION });
const stsClient = new STSClient({ region: process.env.AWS_REGION });

const UPLOADS_BUCKET = process.env.UPLOADS_BUCKET_NAME;

// Cache account ID to avoid repeated STS calls
let cachedAccountId = null;

async function getAccountId() {
  if (cachedAccountId) return cachedAccountId;
  const response = await stsClient.send(new GetCallerIdentityCommand({}));
  cachedAccountId = response.Account;
  return cachedAccountId;
}

function formatSemanticVersion(version) {
  if (!version) return '1.0.0';
  const parts = version.toString().split('.');
  if (parts.length === 1) return `${parts[0]}.0.0`;
  if (parts.length === 2) return `${parts[0]}.${parts[1]}.0`;
  if (parts.length >= 3) return `${parts[0]}.${parts[1]}.${parts[2]}`;
  return '1.0.0';
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS'
};

exports.handler = async (event) => {
  console.log('Event:', JSON.stringify(event, null, 2));
  
  try {
    const { httpMethod, resource, pathParameters } = event;
    const softwareId = pathParameters?.softwareId;
    
    // Handle upload URL request
    if (resource === '/images/software/upload-url' && httpMethod === 'POST') {
      return await generateUploadUrl(JSON.parse(event.body));
    }
    
    switch (httpMethod) {
      case 'GET':
        return softwareId ? await getSoftware(softwareId) : await listSoftware();
      case 'POST':
        return await createSoftware(JSON.parse(event.body));
      case 'PUT':
        return await updateSoftware(softwareId, JSON.parse(event.body));
      case 'DELETE':
        return await deleteSoftware(softwareId);
      default:
        return { statusCode: 405, headers: corsHeaders, body: JSON.stringify({ error: 'Method not allowed' }) };
    }
  } catch (error) {
    console.error('Error:', error);
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: error.message }) };
  }
};

async function generateUploadUrl(body) {
  const { softwareId, fileName, contentType } = body;
  
  if (!softwareId || !fileName) {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'softwareId and fileName are required' }) };
  }
  
  const s3Key = `software/${softwareId}/${fileName}`;
  const command = new PutObjectCommand({
    Bucket: UPLOADS_BUCKET,
    Key: s3Key,
    ContentType: contentType || 'application/octet-stream',
  });
  
  const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 });
  const s3Uri = `s3://${UPLOADS_BUCKET}/${s3Key}`;
  
  return {
    statusCode: 200,
    headers: corsHeaders,
    body: JSON.stringify({ uploadUrl, s3Uri, s3Key })
  };
}

async function listSoftware() {
  const result = await docClient.send(new ScanCommand({ TableName: process.env.SOFTWARE_LIBRARY_TABLE_NAME }));
  return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ items: result.Items || [] }) };
}

async function getSoftware(softwareId) {
  const result = await docClient.send(new GetCommand({
    TableName: process.env.SOFTWARE_LIBRARY_TABLE_NAME,
    Key: { softwareId }
  }));
  
  if (!result.Item) {
    return { statusCode: 404, headers: corsHeaders, body: JSON.stringify({ error: 'Software not found' }) };
  }
  return { statusCode: 200, headers: corsHeaders, body: JSON.stringify(result.Item) };
}


async function createSoftware(software) {
  const softwareId = require('crypto').randomUUID();
  const timestamp = new Date().toISOString();
  
  let componentArn = (software.componentArn && software.componentArn.trim()) ? software.componentArn : '';
  
  // Track if user wants "Latest" display vs specific version
  const isLatest = !software.versionNumber || software.versionNumber.toLowerCase() === 'latest' || software.versionNumber === '';
  const componentVersion = isLatest ? '1.0.0' : formatSemanticVersion(software.versionNumber);
  const displayVersion = isLatest ? 'Latest' : componentVersion;
  
  // Platform defaults to Windows for backward compatibility
  const platform = software.platform || 'Windows';
  
  // If script provided, create ImageBuilder component
  if (software.sourceType === 'script' && software.script) {
    // Include platform in component name to avoid collisions between Windows, Linux, and macOS components
    const baseName = software.name.toLowerCase().replace(/[^a-z0-9]/g, '-');
    const platformSuffix = platform === 'Linux' ? '-linux' : platform === 'macOS' ? '-macos' : '';
    const componentName = `${baseName}${platformSuffix}`;
    const componentDocument = buildComponentDocument(
      software.script,
      software.mediaS3Uri,
      software.mediaFileName,
      platform,
      software.parameters
    );
    
    try {
      const createComponentResponse = await imagebuilderClient.send(new CreateComponentCommand({
        name: componentName,
        semanticVersion: componentVersion,
        description: software.description || `Custom component for ${software.name}`,
        platform: platform,
        data: JSON.stringify(componentDocument)
      }));
      
      componentArn = createComponentResponse.componentBuildVersionArn;
    } catch (error) {
      // If component already exists, reuse it
      if (error.name === 'ResourceAlreadyExistsException') {
        console.log(`Component ${componentName} v${componentVersion} already exists, reusing it`);
        // Construct the ARN from the component name and version
        componentArn = `arn:aws:imagebuilder:${process.env.AWS_REGION}:${process.env.AWS_ACCOUNT_ID || await getAccountId()}:component/${componentName}/${componentVersion}/1`;
      } else {
        console.error('Failed to create ImageBuilder component:', error);
        throw new Error(`Failed to create component: ${error.message}`);
      }
    }
  }
  
  const item = {
    softwareId,
    name: software.name,
    versionNumber: displayVersion,
    componentVersion: componentVersion,
    category: software.category || '',
    description: software.description || '',
    componentArn,
    sourceType: software.sourceType || 'arn',
    platform: platform,
    estimatedInstallTime: software.estimatedInstallTime || '',
    diskSpaceRequired: software.diskSpaceRequired || '',
    gpuRequired: software.gpuRequired || false,
    mediaS3Uri: software.mediaS3Uri || '',
    mediaFileName: software.mediaFileName || '',
    parameters: software.parameters || [],
    createdAt: timestamp,
    updatedAt: timestamp
  };
  
  await docClient.send(new PutCommand({
    TableName: process.env.SOFTWARE_LIBRARY_TABLE_NAME,
    Item: item
  }));
  
  return { statusCode: 201, headers: corsHeaders, body: JSON.stringify(item) };
}

function incrementVersion(version) {
  // Increment patch version: 1.0.0 -> 1.0.1, 1.2.3 -> 1.2.4
  const formatted = formatSemanticVersion(version);
  const parts = formatted.split('.').map(Number);
  parts[2] = parts[2] + 1; // Increment patch
  return parts.join('.');
}

function buildComponentDocument(script, mediaS3Uri, mediaFileName, platform = 'Windows', parameters) {
  const isLinux = platform === 'Linux';
  const isMacOS = platform === 'macOS';
  const isUnixLike = isLinux || isMacOS;
  const executeAction = isUnixLike ? 'ExecuteBash' : 'ExecutePowerShell';
  
  // Build parameter env var lines
  const paramEnvLines = (parameters || []).map(p => {
    if (isUnixLike) {
      return `export ${p.name}="\${${p.name}}"`;
    } else {
      return `# Parameter: ${p.name} - ${p.description || ''}\nif (-not $env:${p.name}) { throw "${p.name} environment variable not set" }`;
    }
  });
  
  if (mediaS3Uri && mediaFileName) {
    // Platform-specific paths and commands
    const downloadPath = isUnixLike 
      ? '/tmp/media-installer/' + mediaFileName
      : 'C:\\Temp\\MediaInstaller\\' + mediaFileName;
    const downloadDir = isUnixLike ? '/tmp/media-installer' : 'C:\\Temp\\MediaInstaller';
    
    const envSetup = isUnixLike
      ? `export MEDIA_PATH="${downloadPath}"`
      : '$env:MEDIA_PATH = "' + downloadPath + '"';
    
    const cleanupCommands = isUnixLike
      ? ['rm -rf /tmp/media-installer || true']
      : ['Remove-Item -Path "C:\\Temp\\MediaInstaller" -Recurse -Force -ErrorAction SilentlyContinue'];
    
    return {
      schemaVersion: '1.0',
      phases: [{
        name: 'build',
        steps: [
          {
            name: 'DownloadMedia',
            action: 'S3Download',
            inputs: [{
              source: mediaS3Uri,
              destination: downloadPath
            }]
          },
          {
            name: 'InstallSoftware',
            action: executeAction,
            inputs: {
              commands: [
                envSetup,
                ...paramEnvLines,
                script
              ]
            }
          },
          {
            name: 'Cleanup',
            action: executeAction,
            inputs: {
              commands: cleanupCommands
            }
          }
        ]
      }]
    };
  } else {
    return {
      schemaVersion: '1.0',
      phases: [{
        name: 'build',
        steps: [{
          name: 'InstallSoftware',
          action: executeAction,
          inputs: {
            commands: [...paramEnvLines, script]
          }
        }]
      }]
    };
  }
}

async function updateSoftware(softwareId, updates) {
  const timestamp = new Date().toISOString();
  
  // Get existing software to check if we need to create a new component version
  const getResult = await docClient.send(new GetCommand({
    TableName: process.env.SOFTWARE_LIBRARY_TABLE_NAME,
    Key: { softwareId }
  }));
  
  const existing = getResult.Item;
  if (!existing) {
    return { statusCode: 404, headers: corsHeaders, body: JSON.stringify({ error: 'Software not found' }) };
  }
  
  let newComponentArn = existing.componentArn;
  let newComponentVersion = existing.componentVersion || existing.versionNumber || '1.0.0';
  let displayVersion = existing.versionNumber; // Preserve "Latest" if that's what was set
  const oldComponentArn = existing.componentArn;
  const isLatest = existing.versionNumber === 'Latest' || existing.versionNumber?.toLowerCase() === 'latest';
  
  // Platform from update or existing (default Windows for backward compatibility)
  const platform = updates.platform || existing.platform || 'Windows';
  
  // If script is provided and changed, create a new component version
  if (updates.script && existing.sourceType === 'script') {
    // Auto-increment the actual component version
    newComponentVersion = incrementVersion(existing.componentVersion || '1.0.0');
    
    // Keep displayVersion as "Latest" if it was "Latest", otherwise show the new version
    if (!isLatest) {
      displayVersion = newComponentVersion;
    }
    
    // Include platform in component name to avoid collisions between Windows, Linux, and macOS components
    const baseName = (updates.name || existing.name).toLowerCase().replace(/[^a-z0-9]/g, '-');
    const platformSuffix = platform === 'Linux' ? '-linux' : platform === 'macOS' ? '-macos' : '';
    const componentName = `${baseName}${platformSuffix}`;
    const componentDocument = buildComponentDocument(
      updates.script,
      updates.mediaS3Uri || existing.mediaS3Uri,
      updates.mediaFileName || existing.mediaFileName,
      platform,
      updates.parameters || existing.parameters
    );
    
    try {
      const createComponentResponse = await imagebuilderClient.send(new CreateComponentCommand({
        name: componentName,
        semanticVersion: newComponentVersion,
        description: updates.description || existing.description || `Custom component for ${updates.name || existing.name}`,
        platform: platform,
        data: JSON.stringify(componentDocument)
      }));
      
      newComponentArn = createComponentResponse.componentBuildVersionArn;
      console.log('Created new component version:', newComponentArn);
      
      // Try to delete old component if not in use
      if (oldComponentArn && oldComponentArn !== newComponentArn) {
        const dependentRecipes = await findRecipesUsingComponent(oldComponentArn);
        if (dependentRecipes.length === 0) {
          try {
            await imagebuilderClient.send(new DeleteComponentCommand({
              componentBuildVersionArn: oldComponentArn
            }));
            console.log('Deleted old component:', oldComponentArn);
          } catch (deleteErr) {
            console.warn('Could not delete old component (may be in use):', deleteErr.message);
          }
        } else {
          console.log('Old component still in use by recipes, keeping it:', dependentRecipes.map(r => r.name).join(', '));
        }
      }
    } catch (error) {
      console.error('Failed to create new component version:', error);
      return { 
        statusCode: 500, 
        headers: corsHeaders, 
        body: JSON.stringify({ error: `Failed to create new component version: ${error.message}` }) 
      };
    }
  }
  
  const item = {
    ...existing,
    ...updates,
    softwareId,
    componentArn: newComponentArn,
    componentVersion: newComponentVersion,
    versionNumber: displayVersion,
    platform: platform,
    parameters: updates.parameters || existing.parameters || [],
    updatedAt: timestamp
  };
  
  // Don't store the script in DynamoDB (it's in the component)
  delete item.script;
  
  await docClient.send(new PutCommand({
    TableName: process.env.SOFTWARE_LIBRARY_TABLE_NAME,
    Item: item
  }));
  
  return { 
    statusCode: 200, 
    headers: corsHeaders, 
    body: JSON.stringify({
      ...item,
      previousComponentArn: oldComponentArn !== newComponentArn ? oldComponentArn : undefined,
      versionIncremented: oldComponentArn !== newComponentArn
    }) 
  };
}

async function findRecipesUsingComponent(componentArn) {
  // Extract the component name/version pattern to match against recipes
  // Component ARN format: arn:aws:imagebuilder:region:account:component/name/version/build
  const recipes = [];
  
  try {
    // List all recipes
    const listResult = await imagebuilderClient.send(new ListImageRecipesCommand({
      owner: 'Self'
    }));
    
    // Check each recipe for the component
    for (const recipeSummary of (listResult.imageRecipeSummaryList || [])) {
      try {
        const recipeDetail = await imagebuilderClient.send(new GetImageRecipeCommand({
          imageRecipeArn: recipeSummary.arn
        }));
        
        const recipe = recipeDetail.imageRecipe;
        if (recipe?.components) {
          // Check if any component in the recipe matches our component ARN
          const usesComponent = recipe.components.some(c => 
            c.componentArn === componentArn || 
            // Also check base ARN without build number
            c.componentArn?.startsWith(componentArn.split('/').slice(0, -1).join('/'))
          );
          
          if (usesComponent) {
            recipes.push({
              name: recipe.name,
              arn: recipe.arn,
              version: recipe.version
            });
          }
        }
      } catch (err) {
        console.warn('Could not check recipe', recipeSummary.arn + ':', err.message);
      }
    }
  } catch (error) {
    console.error('Error listing recipes:', error.message);
  }
  
  return recipes;
}

async function deleteSoftware(softwareId) {
  // Get the software item first
  const getResult = await docClient.send(new GetCommand({
    TableName: process.env.SOFTWARE_LIBRARY_TABLE_NAME,
    Key: { softwareId }
  }));
  
  const software = getResult.Item;
  if (!software) {
    return { statusCode: 404, headers: corsHeaders, body: JSON.stringify({ error: 'Software not found' }) };
  }
  
  const errors = [];
  
  // Delete ImageBuilder component first (if it fails due to dependencies, don't delete from DB)
  if (software.componentArn && software.sourceType === 'script') {
    // First, check if any recipes are using this component
    const dependentRecipes = await findRecipesUsingComponent(software.componentArn);
    
    if (dependentRecipes.length > 0) {
      const recipeNames = dependentRecipes.map(r => r.name).join(', ');
      return { 
        statusCode: 409, 
        headers: corsHeaders, 
        body: JSON.stringify({ 
          error: `Cannot delete: component is used by ${dependentRecipes.length} image recipe(s): ${recipeNames}. Delete or update the recipe(s) first.`,
          componentArn: software.componentArn,
          dependentRecipes: dependentRecipes
        }) 
      };
    }
    
    try {
      await imagebuilderClient.send(new DeleteComponentCommand({
        componentBuildVersionArn: software.componentArn
      }));
      console.log('Deleted ImageBuilder component:', software.componentArn);
    } catch (error) {
      console.error('Failed to delete ImageBuilder component:', error.message);
      // Check if it's a dependency error (fallback in case our check missed something)
      if (error.name === 'ResourceDependencyException' || error.message.includes('depended on')) {
        return { 
          statusCode: 409, 
          headers: corsHeaders, 
          body: JSON.stringify({ 
            error: 'Cannot delete: component is used by an image recipe or pipeline. Delete the dependent resources first.',
            componentArn: software.componentArn
          }) 
        };
      }
      errors.push(`ImageBuilder component: ${error.message}`);
    }
  }
  
  // Delete media file from S3 if exists
  if (software.mediaS3Uri && UPLOADS_BUCKET) {
    try {
      const s3Key = `software/${softwareId}/${software.mediaFileName}`;
      await s3Client.send(new DeleteObjectCommand({
        Bucket: UPLOADS_BUCKET,
        Key: s3Key
      }));
      console.log('Deleted media file from S3:', s3Key);
    } catch (error) {
      console.warn('Failed to delete media file from S3:', error.message);
      errors.push(`S3 media file: ${error.message}`);
    }
  }
  
  // Delete from DynamoDB
  await docClient.send(new DeleteCommand({
    TableName: process.env.SOFTWARE_LIBRARY_TABLE_NAME,
    Key: { softwareId }
  }));
  
  // Return partial success if there were non-blocking errors
  if (errors.length > 0) {
    return { 
      statusCode: 200, 
      headers: corsHeaders, 
      body: JSON.stringify({ 
        message: 'Deleted from database but some resources could not be cleaned up',
        warnings: errors
      }) 
    };
  }
  
  return { statusCode: 204, headers: corsHeaders, body: '' };
}
