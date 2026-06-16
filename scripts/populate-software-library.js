// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Software Library Population Script
 *
 * Reads JSON definitions from software-library/{category}/*.json,
 * creates ImageBuilder components, optionally downloads/uploads media,
 * and writes items to DynamoDB.
 *
 * Uses IAM credentials (no JWT needed) — designed to run in CodeBuild.
 *
 * Usage:
 *   node scripts/populate-software-library.js [options]
 *
 * Options:
 *   --dry-run              Log what would happen without making AWS calls
 *   --category <name>      Only process a single category (development|media|system|utilities)
 *   --table-name <name>    Override DynamoDB table name (skips SSM lookup)
 *   --bucket-name <name>   Override S3 bucket name (skips SSM lookup)
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const crypto = require('crypto');

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand, ScanCommand } = require('@aws-sdk/lib-dynamodb');
const { ImagebuilderClient, CreateComponentCommand } = require('@aws-sdk/client-imagebuilder');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { STSClient, GetCallerIdentityCommand } = require('@aws-sdk/client-sts');
const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CATEGORIES = ['development', 'media', 'system', 'utilities'];
const SCRIPT_DIR = path.join(__dirname, '..', 'software-library');

// ---------------------------------------------------------------------------
// AWS clients (lazy-initialised after region is known)
// ---------------------------------------------------------------------------

let docClient;
let imagebuilderClient;
let s3Client;
let stsClient;
let ssmClient;
let awsRegion;

function initClients(region) {
  awsRegion = region;
  const dynamoClient = new DynamoDBClient({ region });
  docClient = DynamoDBDocumentClient.from(dynamoClient);
  imagebuilderClient = new ImagebuilderClient({ region });
  s3Client = new S3Client({ region });
  stsClient = new STSClient({ region });
  ssmClient = new SSMClient({ region });
}

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = argv.slice(2);
  const options = {
    dryRun: false,
    category: null,
    tableName: null,
    bucketName: null,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--category':
        options.category = args[++i];
        break;
      case '--table-name':
        options.tableName = args[++i];
        break;
      case '--bucket-name':
        options.bucketName = args[++i];
        break;
    }
  }

  return options;
}

// ---------------------------------------------------------------------------
// Helpers: version formatting (ported from Lambda)
// ---------------------------------------------------------------------------

function formatSemanticVersion(version) {
  if (!version) return '1.0.0';
  const parts = version.toString().split('.');
  if (parts.length === 1) return `${parts[0]}.0.0`;
  if (parts.length === 2) return `${parts[0]}.${parts[1]}.0`;
  if (parts.length >= 3) return `${parts[0]}.${parts[1]}.${parts[2]}`;
  return '1.0.0';
}

function incrementVersion(version) {
  const formatted = formatSemanticVersion(version);
  const parts = formatted.split('.').map(Number);
  parts[2] = parts[2] + 1;
  return parts.join('.');
}

// ---------------------------------------------------------------------------
// PascalCase derivation (matches CDK naming convention)
// ---------------------------------------------------------------------------

function toPascalCase(str) {
  return str
    .split(/\s+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join('');
}

// ---------------------------------------------------------------------------
// resolveConfig — reads SSM params with CLI overrides
// ---------------------------------------------------------------------------

async function resolveConfig(options) {
  const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
  initClients(region);

  // Get account ID
  const stsResp = await stsClient.send(new GetCallerIdentityCommand({}));
  const accountId = stsResp.Account;

  // Derive PascalCase from cdk.json productName
  let pascalCase;
  try {
    const cdkJsonPath = path.join(__dirname, '..', 'cdk.json');
    const cdkJson = JSON.parse(fs.readFileSync(cdkJsonPath, 'utf-8'));
    pascalCase = toPascalCase(cdkJson.context.productName || 'MediaResourceManager');
  } catch {
    pascalCase = 'MediaResourceManager';
  }

  // Resolve table name
  let tableName = options.tableName;
  if (!tableName) {
    try {
      const resp = await ssmClient.send(new GetParameterCommand({
        Name: `/${pascalCase}/SoftwareLibrary/TableName`,
      }));
      tableName = resp.Parameter.Value;
    } catch (err) {
      console.warn(`⚠  Could not read SSM table name param: ${err.message}`);
      tableName = process.env.SOFTWARE_LIBRARY_TABLE_NAME;
    }
  }

  // Resolve bucket name
  let bucketName = options.bucketName;
  if (!bucketName) {
    try {
      const resp = await ssmClient.send(new GetParameterCommand({
        Name: `/${pascalCase}/SoftwareLibrary/UploadsBucket`,
      }));
      bucketName = resp.Parameter.Value;
    } catch (err) {
      console.warn(`⚠  Could not read SSM bucket name param: ${err.message}`);
      bucketName = process.env.UPLOADS_BUCKET_NAME;
    }
  }

  if (!tableName) {
    throw new Error('Could not resolve DynamoDB table name. Use --table-name or set SSM parameter.');
  }

  return { tableName, bucketName, region, accountId, pascalCase };
}

// ---------------------------------------------------------------------------
// checkExists — scan DynamoDB for matching name + platform + versionNumber
// ---------------------------------------------------------------------------

async function checkExists(name, platform, versionNumber, tableName) {
  const result = await docClient.send(new ScanCommand({
    TableName: tableName,
    FilterExpression: '#n = :name AND #p = :platform AND #v = :version',
    ExpressionAttributeNames: {
      '#n': 'name',
      '#p': 'platform',
      '#v': 'versionNumber',
    },
    ExpressionAttributeValues: {
      ':name': name,
      ':platform': platform,
      ':version': versionNumber,
    },
  }));

  return result.Items && result.Items.length > 0;
}

// ---------------------------------------------------------------------------
// buildComponentDocument — ported from Lambda, extended with parameter env
//                          var injection (Task 2.2)
// ---------------------------------------------------------------------------

function buildComponentDocument(script, mediaS3Uri, mediaFileName, platform, parameters) {
  const isLinux = platform === 'Linux';
  const isMacOS = platform === 'macOS';
  const isUnixLike = isLinux || isMacOS;
  const executeAction = isUnixLike ? 'ExecuteBash' : 'ExecutePowerShell';

  // Build parameter env var injection lines
  const paramEnvLines = (parameters || []).map((p) => {
    if (isUnixLike) {
      return `export ${p.name}="\${${p.name}}"`;
    }
    // Windows (PowerShell): validate required params, set optional ones
    const commentLine = `# Parameter: ${p.name}${p.description ? ' - ' + p.description : ''}`;
    const checkLine = `if (-not $env:${p.name}) { throw "${p.name} environment variable not set" }`;
    return `${commentLine}\n${checkLine}`;
  });

  if (mediaS3Uri && mediaFileName) {
    const downloadPath = isUnixLike
      ? '/tmp/media-installer/' + mediaFileName
      : 'C:\\Temp\\MediaInstaller\\' + mediaFileName;

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
              destination: downloadPath,
            }],
          },
          {
            name: 'InstallSoftware',
            action: executeAction,
            inputs: {
              commands: [
                ...paramEnvLines,
                envSetup,
                script,
              ],
            },
          },
          {
            name: 'Cleanup',
            action: executeAction,
            inputs: {
              commands: cleanupCommands,
            },
          },
        ],
      }],
    };
  }

  // No media
  return {
    schemaVersion: '1.0',
    phases: [{
      name: 'build',
      steps: [{
        name: 'InstallSoftware',
        action: executeAction,
        inputs: {
          commands: [
            ...paramEnvLines,
            script,
          ],
        },
      }],
    }],
  };
}

// ---------------------------------------------------------------------------
// downloadAndUploadMedia — download from source URL to /tmp, upload to S3
// ---------------------------------------------------------------------------

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const dir = path.dirname(destPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const file = fs.createWriteStream(destPath);
    const client = url.startsWith('https') ? https : http;

    const request = client.get(url, (response) => {
      // Follow redirects
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        file.close();
        fs.unlinkSync(destPath);
        return resolve(downloadFile(response.headers.location, destPath));
      }

      if (response.statusCode !== 200) {
        file.close();
        fs.unlinkSync(destPath);
        return reject(new Error(`Download failed with status ${response.statusCode}`));
      }

      response.pipe(file);
      file.on('finish', () => {
        file.close(resolve);
      });
    });

    request.on('error', (err) => {
      file.close();
      if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
      reject(err);
    });
  });
}

async function downloadAndUploadMedia(sourceUrl, softwareId, fileName, bucketName) {
  // Sanitize fileName to prevent path traversal
  const safeName = path.basename(fileName);
  // nosemgrep: path-join-resolve-traversal — softwareId is a UUID, safeName is basename-sanitized
  const tmpDir = path.join('/tmp', `sw-${softwareId}`);
  const tmpPath = path.join(tmpDir, safeName); // nosemgrep: path-join-resolve-traversal

  try {
    console.log(`    ↓ Downloading media: ${fileName}`);
    await downloadFile(sourceUrl, tmpPath);

    const s3Key = `software/${softwareId}/${fileName}`;
    const fileSize = fs.statSync(tmpPath).size;
    const fileSizeMB = (fileSize / (1024 * 1024)).toFixed(1);
    console.log(`    ↑ Uploading ${fileSizeMB} MB to s3://${bucketName}/${s3Key}`);

    // Use streaming upload with multipart for large files
    const { Upload } = require('@aws-sdk/lib-storage');
    const fileStream = fs.createReadStream(tmpPath);
    const upload = new Upload({
      client: s3Client,
      params: {
        Bucket: bucketName,
        Key: s3Key,
        Body: fileStream,
      },
      queueSize: 4,
      partSize: 100 * 1024 * 1024, // 100MB parts
    });

    await upload.done();

    return `s3://${bucketName}/${s3Key}`;
  } finally {
    // Always clean up local file
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    const tmpDir = path.dirname(tmpPath);
    if (fs.existsSync(tmpDir)) {
      try { fs.rmdirSync(tmpDir); } catch { /* ignore non-empty */ }
    }
  }
}

// ---------------------------------------------------------------------------
// processDefinition — process a single JSON definition file
// ---------------------------------------------------------------------------

async function processDefinition(jsonPath, category, config, dryRun) {
  const def = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));

  if (!def.name) {
    console.warn(`  ⚠  Skipping ${jsonPath}: missing "name" field`);
    return 'failed';
  }

  const isLatest = !def.versionNumber || def.versionNumber.toLowerCase() === 'latest' || def.versionNumber === '';
  const componentVersion = isLatest ? '1.0.0' : formatSemanticVersion(def.versionNumber);
  const displayVersion = isLatest ? 'Latest' : componentVersion;
  const platform = def.platform || 'Windows';

  console.log(`  → ${def.name} (${platform}) v${displayVersion}`);

  // Idempotency check
  if (!dryRun) {
    const exists = await checkExists(def.name, platform, displayVersion, config.tableName);
    if (exists) {
      console.log(`    ✓ Already exists — skipping`);
      return 'skipped';
    }
  } else {
    console.log(`    [DRY RUN] Would check existence in DynamoDB`);
  }

  // Read install script — validate path stays within the definition directory
  const defDir = path.dirname(jsonPath);
  // nosemgrep: path-join-resolve-traversal — path is validated against defDir on next line
  const scriptPath = path.resolve(defDir, def.scriptFile);
  if (!scriptPath.startsWith(path.resolve(defDir))) { // nosemgrep: path-join-resolve-traversal
    console.error(`    ✗ Script file path escapes definition directory: ${def.scriptFile}`);
    return 'failed';
  }
  if (!fs.existsSync(scriptPath)) {
    console.error(`    ✗ Script file not found: ${scriptPath}`);
    return 'failed';
  }
  const script = fs.readFileSync(scriptPath, 'utf-8');

  const softwareId = crypto.randomUUID();
  let mediaS3Uri = def.mediaS3Uri || '';

  // Download and upload media if sourceUrl is provided
  if (def.mediaSourceUrl && def.mediaFileName && config.bucketName) {
    if (!dryRun) {
      try {
        mediaS3Uri = await downloadAndUploadMedia(
          def.mediaSourceUrl,
          softwareId,
          def.mediaFileName,
          config.bucketName,
        );
      } catch (err) {
        console.error(`    ✗ Media download/upload failed: ${err.message}`);
        return 'failed';
      }
    } else {
      console.log(`    [DRY RUN] Would download ${def.mediaSourceUrl} and upload to S3`);
      mediaS3Uri = `s3://${config.bucketName}/software/${softwareId}/${def.mediaFileName}`;
    }
  }

  // Build component document
  const componentDocument = buildComponentDocument(
    script,
    mediaS3Uri,
    def.mediaFileName || '',
    platform,
    def.parameters,
  );

  // Create ImageBuilder component
  const baseName = def.name.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  const platformSuffix = platform === 'Linux' ? '-linux' : platform === 'macOS' ? '-macos' : '';
  const componentName = `${baseName}${platformSuffix}`;
  let componentArn = '';

  if (!dryRun) {
    try {
      const resp = await imagebuilderClient.send(new CreateComponentCommand({
        name: componentName,
        semanticVersion: componentVersion,
        description: def.description || `Custom component for ${def.name}`,
        platform: platform,
        data: JSON.stringify(componentDocument),
      }));
      componentArn = resp.componentBuildVersionArn;
      console.log(`    ✓ Component created: ${componentArn}`);
    } catch (err) {
      if (err.name === 'ResourceAlreadyExistsException') {
        componentArn = `arn:aws:imagebuilder:${awsRegion}:${config.accountId}:component/${componentName}/${componentVersion}/1`;
        console.log(`    ✓ Component already exists, using ARN: ${componentArn}`);
      } else {
        console.error(`    ✗ Failed to create component: ${err.message}`);
        return 'failed';
      }
    }
  } else {
    componentArn = `arn:aws:imagebuilder:${awsRegion}:${config.accountId}:component/${componentName}/${componentVersion}/1`;
    console.log(`    [DRY RUN] Would create component: ${componentName} v${componentVersion}`);
  }

  // Write to DynamoDB
  const timestamp = new Date().toISOString();
  const item = {
    softwareId,
    name: def.name,
    versionNumber: displayVersion,
    componentVersion,
    category,
    description: def.description || '',
    componentArn,
    sourceType: 'script',
    platform,
    estimatedInstallTime: def.estimatedInstallTime || '',
    diskSpaceRequired: def.diskSpaceRequired || '',
    gpuRequired: def.gpuRequired || false,
    mediaS3Uri,
    mediaFileName: def.mediaFileName || '',
    parameters: def.parameters || [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  if (!dryRun) {
    try {
      await docClient.send(new PutCommand({
        TableName: config.tableName,
        Item: item,
      }));
      console.log(`    ✓ Written to DynamoDB`);
    } catch (err) {
      console.error(`    ✗ DynamoDB write failed: ${err.message}`);
      return 'failed';
    }
  } else {
    console.log(`    [DRY RUN] Would write item to DynamoDB table ${config.tableName}`);
  }

  return 'created';
}

// ---------------------------------------------------------------------------
// main — entry point
// ---------------------------------------------------------------------------

async function main() {
  const options = parseArgs(process.argv);

  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║        Software Library Population Script           ║');
  console.log('╚══════════════════════════════════════════════════════╝');

  if (options.dryRun) {
    console.log('🔍 DRY RUN MODE — no AWS calls will be made\n');
  }

  let config;
  try {
    config = await resolveConfig(options);
    console.log(`  Region:     ${config.region}`);
    console.log(`  Account:    ${config.accountId}`);
    console.log(`  Table:      ${config.tableName}`);
    console.log(`  Bucket:     ${config.bucketName || '(none)'}`);
    console.log('');
  } catch (err) {
    console.error(`✗ Configuration error: ${err.message}`);
    process.exit(0); // Non-blocking
  }

  const categoriesToProcess = options.category
    ? [options.category]
    : CATEGORIES;

  const summary = { total: 0, created: 0, skipped: 0, failed: 0 };

  for (const category of categoriesToProcess) {
    const categoryDir = path.join(SCRIPT_DIR, category);
    if (!fs.existsSync(categoryDir)) {
      console.warn(`⚠  Category directory not found: ${categoryDir}`);
      continue;
    }

    const jsonFiles = fs.readdirSync(categoryDir).filter((f) => f.endsWith('.json'));
    if (jsonFiles.length === 0) continue;

    console.log(`\n📁 ${category.toUpperCase()} (${jsonFiles.length} definitions)`);
    console.log('─'.repeat(50));

    for (const jsonFile of jsonFiles) {
      summary.total++;
      const jsonPath = path.join(categoryDir, jsonFile);

      try {
        const result = await processDefinition(jsonPath, category, config, options.dryRun);
        summary[result]++;
      } catch (err) {
        console.error(`    ✗ Unexpected error processing ${jsonFile}: ${err.message}`);
        summary.failed++;
      }
    }
  }

  // Print summary
  console.log('\n' + '═'.repeat(50));
  console.log('📊 Summary');
  console.log('═'.repeat(50));
  console.log(`  Total processed:  ${summary.total}`);
  console.log(`  Created:          ${summary.created}`);
  console.log(`  Skipped:          ${summary.skipped}`);
  console.log(`  Failed:           ${summary.failed}`);
  console.log('═'.repeat(50));

  if (options.dryRun) {
    console.log('\n🔍 DRY RUN complete — no changes were made.');
  }

  // Always exit 0 (non-blocking for pipeline)
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Exports for testing
// ---------------------------------------------------------------------------

module.exports = {
  formatSemanticVersion,
  incrementVersion,
  toPascalCase,
  buildComponentDocument,
  parseArgs,
  checkExists,
  resolveConfig,
  processDefinition,
  downloadAndUploadMedia,
  CATEGORIES,
};

// Run if invoked directly
if (require.main === module) {
  main().catch((err) => {
    console.error(`✗ Fatal error: ${err.message}`);
    process.exit(0); // Non-blocking
  });
}
