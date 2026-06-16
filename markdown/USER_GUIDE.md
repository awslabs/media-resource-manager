# Media Resource Manager User Guide

This guide covers how to use the Media Resource Manager web console for both administrators and end users.

## Table of Contents

- [Getting Started](#getting-started)
- [Dashboard](#dashboard)
- [For Users](#for-users)
  - [Viewing Your Workstations](#viewing-your-workstations)
  - [Starting a Workstation](#starting-a-workstation)
  - [Connecting via DCV](#connecting-via-dcv)
  - [Stopping a Workstation](#stopping-a-workstation)
- [For Administrators](#for-administrators)
  - [Managing Workstations](#managing-workstations)
  - [Managing Users](#managing-users)
  - [Managing Groups](#managing-groups)
  - [Image Management](#image-management)
    - [Images Page](#images-page)
    - [Pipelines Page](#pipelines-page)
    - [Software Library](#software-library)
    - [AI Script Generator](#ai-script-generator)
  - [Storage Management](#storage-management)
  - [Settings](#settings)
- [Tips & Best Practices](#tips--best-practices)

---

## Getting Started

### First Sign-In

1. Navigate to the Media Resource Manager URL provided by your administrator
2. Sign in using one of the available methods:
   - **Cognito**: Click "Sign in with Cognito" and use your corporate credentials (Okta, Identity Center, or Cognito user)
   - **LDAP**: Enter your Active Directory username and password

3. After signing in, you'll land on the **Dashboard**

### Navigation

The left sidebar provides access to all features:

| Menu Item | Description | Access |
|-----------|-------------|--------|
| **Dashboard** | Overview of your workstations and quick actions | All users |
| **Workstations** | Full workstation management | All users (view own), Admins (manage all) |
| **Users** | User account management | Admins only |
| **Groups** | Group management for workstation assignment | Admins only |
| **Images** | AMI and image pipeline management | Admins only |
| **Storage** | FSx storage resource management | Admins only |
| **Buckets** | S3 media bucket browser | All users |
| **Settings** | Application configuration | Admins only |

---

## Dashboard

The Dashboard provides a quick overview of your environment:

### For Users
- **Your Workstations**: Cards showing each workstation assigned to you
- **Quick Actions**: Start, stop, or connect to workstations directly
- **Status Indicators**: Real-time status of each workstation (Running, Stopped, Starting, etc.)

### For Administrators
- **All Workstations**: Overview of all workstations in the system
- **Recent Activity**: Latest workstation operations
- **System Health**: Quick view of infrastructure status

---

## For Users

### Viewing Your Workstations

1. Go to **Dashboard** or **Workstations** page
2. You'll see all workstations assigned to you
3. Each workstation card shows:
   - **Name**: Workstation hostname (e.g., `vdi-0001`)
   - **Status**: Current state (Running, Stopped, Starting, Stopping)
   - **Instance Type**: EC2 instance size (e.g., g4dn.xlarge)
   - **Platform**: Operating system (Windows, Ubuntu, Rocky Linux, macOS)
   - **Assigned User**: Who the workstation belongs to

### Starting a Workstation

1. Find your workstation on the Dashboard or Workstations page
2. Click the **Start** button (play icon)
3. Wait for the status to change from "Stopped" → "Starting" → "Running"
4. Starting typically takes 2-5 minutes depending on the instance type

**Note**: Workstations may have auto-shutdown policies. Check with your administrator for shutdown schedules.

### Connecting via DCV

Once your workstation is running:

1. Click the **Connect** button on your workstation card
2. Choose your connection method:
   - **Browser**: Opens DCV session in a new browser tab (no installation required)
   - **DCV Client**: Opens the native DCV client application (better performance)

**Browser Connection:**
- Works on any modern browser (Chrome, Firefox, Edge, Safari)
- Good for quick access or when DCV client isn't installed
- May have slightly higher latency than native client

**DCV Client Connection:**
- Download from [NICE DCV Client Downloads](https://download.nice-dcv.com/)
- Better performance for graphics-intensive work
- Supports features like USB redirection and multi-monitor

### Stopping a Workstation

1. Click the **Stop** button (stop icon) on your workstation
2. Confirm the action when prompted
3. The workstation will shut down gracefully

**Important**: 
- Save your work before stopping
- Stopping a workstation preserves your data on the attached storage
- Stopped workstations don't incur EC2 compute charges (storage charges still apply)

---

## For Administrators

### Managing Workstations

#### Creating a Workstation

1. Go to **Workstations** page
2. Click **Create Workstation**
3. Fill in the details:
   - **Name**: Optional custom name (auto-generated if blank)
   - **AMI**: Select from approved images
   - **Instance Type**: Choose based on user needs
   - **Assigned User**: Select the user who will use this workstation
   - **Storage**: Optionally attach FSx storage
4. Click **Create**
5. Monitor progress in the workstation list

#### Bulk Operations

Select multiple workstations using checkboxes, then use the action menu:
- **Start Selected**: Start multiple workstations
- **Stop Selected**: Stop multiple workstations
- **Delete Selected**: Remove workstations (requires confirmation)

#### Workstation Details

Click on a workstation to view:
- Instance details (ID, type, launch time)
- Network information (private IP, security groups)
- DCV session status
- Assigned user information
- Auto-shutdown policy

### Managing Users

#### Viewing Users

1. Go to **Users** page
2. View all users in the system with their:
   - Name and email
   - Admin status
   - Number of assigned workstations
   - Last login time

#### Creating Users (LDAP Mode)

In LDAP mode, users are managed through Active Directory. Use standard AD tools to create users.

#### Creating Users (Cognito Mode)

**With SAML Provider (Okta/Identity Center):**
Users are automatically created on first sign-in through the identity provider.

**Native Cognito Users:**
1. Go to **Users** page
2. Click **Create User**
3. Enter email address
4. User receives invitation email with temporary password

#### Syncing Users from Identity Center

If using IAM Identity Center:
1. Go to **Users** page
2. Click **Sync Users**
3. Users from configured groups are imported

#### Disabling/Enabling Users

1. Select users using checkboxes
2. Click **Disable** or **Enable** from the action menu
3. Disabled users cannot sign in but their workstations are preserved

### Managing Groups

Groups allow you to organize users and assign workstations to multiple users.

#### Creating a Group

1. Go to **Groups** page
2. Click **Create Group**
3. Enter group name and description
4. Add members from the user list
5. Click **Create**

#### Assigning Workstations to Groups

When creating a workstation, you can assign it to a group instead of an individual user. All group members can then access the workstation.

### Image Management

The Image Builder section has three main pages: **Images**, **Pipelines**, and **Software**. Together they let you manage base AMIs, build custom images with pre-installed software, and maintain a reusable software library.

#### Images Page

The Images page shows all AMIs registered in the system. Each image displays its name, platform (Windows, Linux, macOS), region(s), type, state, and creation date.

Images are categorized by type:
- **Base Image**: Auto-generated AMIs managed by AWS (cannot be edited or deleted)
- **Pipeline**: AMIs produced by an image build pipeline
- **Imported**: AMIs manually imported by an administrator

**Importing an existing AMI:**

1. Go to **Images** page
2. Click **Import Image**
3. Enter the AMI ID (e.g., `ami-0123456789abcdef0`)
4. Provide a name, select the platform, and optionally add a description
5. Click **Import**

**Copying images to other regions:**

If you have regional hubs configured, you can distribute an image to other regions:

1. Select an image from the table
2. Click **Copy to Region**
3. Select one or more target regions
4. Click **Copy Image** — the copy runs in the background and may take several minutes

**Creating a workstation from an image:**

1. Select an image from the table
2. Click **Create Workstation** — this takes you to the workstation creation page with the image pre-selected

#### Pipelines Page

Pipelines use [EC2 Image Builder](https://docs.aws.amazon.com/imagebuilder/latest/userguide/what-is-image-builder.html) to produce custom AMIs with your software pre-installed. This is the recommended way to standardize workstation images across your organization.

**Viewing pipelines:**

1. Go to **Pipelines** page
2. View all pipelines with their name, base image, component count, status, and creation date
3. Pipeline statuses include: Created, Building, Completed, Failed

**Creating a new pipeline (step-by-step wizard):**

1. From the **Pipelines** page, click **Create Pipeline** (or navigate to **Images** → **Create**)
2. **Step 1 — Pipeline Configuration:**
   - Enter a pipeline name (e.g., "VFX Artist Workstation")
   - Add an optional description
   - Select a base image by platform tab:
     - **Windows**: Windows Server 2025, 2022, or 2019
     - **Linux**: Ubuntu 22.04 LTS, Rocky Linux 8, or Rocky Linux 9
     - **macOS**: Select from previously built DCV-Ready macOS images (requires building a system pipeline first)
3. **Step 2 — Software Components:**
   - The software library is filtered to show only components matching your selected platform
   - Select software by clicking the cards (multi-select supported)
   - Use the search/filter bar to find software by name or category
   - You can also add a **custom script** (PowerShell for Windows, Bash for Linux) for one-off configuration
   - If the software you need isn't in the library, click **Add Software** to add it inline (see [Software Library](#software-library) below)
   - Some software components have configurable parameters (e.g., license keys, install paths) — fill these in when prompted
4. **Step 3 — Review & Create:**
   - Review your pipeline configuration, base image, and selected components
   - The wizard auto-selects the build instance type: `g4dn.xlarge` for GPU-required software, `m5.large` otherwise, `mac2.metal` for macOS
   - Click **Create Pipeline**

**Building a pipeline:**

1. Select one or more pipelines from the table
2. Click **Build** — this triggers EC2 Image Builder to launch a build instance, install all components, create an AMI, and clean up
3. Build progress is tracked in the pipeline status (Building → Completed or Failed)
4. When complete, the resulting AMI appears on the **Images** page

**Editing a pipeline:**

1. Select a pipeline and click **Edit**
2. You can add, remove, or update software component versions
3. Saving creates a new recipe version in Image Builder

**Deleting a pipeline:**

1. Select one or more pipelines and click **Delete**
2. System pipelines (e.g., macOS DCV-Ready base image builders) cannot be deleted
3. Deleting a pipeline removes the Image Builder resources but does not delete AMIs already built by it

#### Software Library

The Software Library is a catalog of reusable installation components. Each entry becomes an EC2 Image Builder component that can be added to any pipeline.

**Viewing the software library:**

1. Go to **Software** page (under Image Builder in the sidebar)
2. Browse all registered software with name, version, platform, category, and description
3. Filter by platform (Windows, Linux, macOS) or category (Development, Media, System, Utilities)
4. Click a software name to view its details, including the installation script

**Adding software to the library (Add Software Wizard):**

1. Click **Add Software** to open the wizard
2. **Step 1 — Software Details:**
   - Name, version, category, description
   - Platform (Windows, Linux, macOS)
   - Estimated install time and disk space required
   - Whether GPU is required (affects build instance type selection)
3. **Step 2 — Installation Media (optional):**
   - Upload an installer file (e.g., `.exe`, `.msi`, `.dmg`) — it's stored in S3 and downloaded during the build
   - Skip this step if the software is installed via a script (e.g., `choco install`, `apt-get install`, or downloading from a URL)
4. **Step 3 — Installation Script:**
   - **Manual**: Write a PowerShell (Windows) or Bash (Linux) script that performs the silent installation
   - **AI-assisted** (requires Bedrock enabled): Use the built-in AI agent to generate and test the script (see below)
   - Alternatively, provide an existing EC2 Image Builder component ARN if you've already created one
5. **Step 4 — Review & Create:**
   - Review all details and click **Create**
   - The system creates an EC2 Image Builder component from your script

**Editing software:**

1. Select a software entry and click **Edit**
2. You can update the name, category, description, install time, disk space, and GPU requirement
3. For script-based components, you can update the installation script — this creates a new component version internally

**Deleting software:**

1. Select one or more entries and click **Delete**
2. This permanently removes the software from the library, deletes the Image Builder component, and removes any uploaded media files

#### AI Script Generator

If Bedrock features are enabled, the AI Script Generator can help create installation scripts automatically. It uses Amazon Bedrock (Claude) to research silent installation methods, generate platform-specific scripts, and optionally test them on a real EC2 instance.

**Generating a script for new software (during Add Software Wizard):**

1. In Step 3 of the Add Software Wizard, select the **AI** tab
2. The AI agent greets you and asks for requirements
3. Type "generate" to start, or describe specific requirements (e.g., "install to D:\Apps, use license key from Secrets Manager")
4. The agent will:
   - Research silent install methods for the software
   - Generate a PowerShell or Bash script
   - Optionally launch a test EC2 instance, run the script, and verify the installation
   - If the test fails, it analyzes the error and generates a corrected script (up to 3 attempts)
5. Once successful, the generated script is automatically populated into the wizard

**Generating a script for existing software:**

1. Go to the **Software** page
2. Select a script-based software entry
3. Click **Generate Script** — this opens the AI Script Generator chat interface
4. The agent can refine an existing script or generate a new one from scratch
5. On success, the software entry is updated with the new script

**Notes on AI Script Generation:**
- Requires `EnableBedrockFeatures` to be set to `true` in your deployment configuration
- Test instances use `t3.medium` in an isolated subnet with minimal permissions
- Each generation attempt has a 15-minute timeout, with a maximum of 3 attempts
- The agent can handle installer files uploaded to S3 (referenced via the media upload step)

### Storage Management

#### Viewing Storage Resources

1. Go to **Storage** page
2. View FSx file systems with:
   - Name and type
   - Capacity and throughput
   - Status
   - Attached workstations

#### Creating Storage

1. Click **Create Storage**
2. Configure:
   - **Name**: Storage identifier
   - **Type**: FSx for NetApp ONTAP
   - **Capacity**: Storage size in GB
   - **Throughput**: Performance tier
3. Click **Create**

#### Attaching Storage to Workstations

Storage can be attached when creating a workstation or added later:
1. Edit the workstation
2. Select storage resource
3. Specify mount point
4. Save changes

### Settings

#### Application Settings

Configure global application behavior:
- **Auto-shutdown**: Default shutdown policies
- **Session timeout**: DCV session duration
- **Notifications**: Email alerts for admins

#### Authentication Settings

View and manage authentication configuration:
- Current auth mode (LDAP/Cognito)
- Identity provider status
- User pool settings

---

## Tips & Best Practices

### For Users

1. **Save frequently**: Auto-shutdown policies may stop your workstation after idle periods
2. **Use the DCV client**: For graphics work, the native client provides better performance
3. **Stop when done**: Help reduce costs by stopping workstations you're not using
4. **Check your timezone**: Scheduled shutdowns are based on configured timezone

### For Administrators

1. **Right-size instances**: Match instance types to user workloads
2. **Use image pipelines**: Standardize software across workstations — build a pipeline once, then create workstations from the resulting AMI
3. **Build a software library first**: Before creating pipelines, populate the software library with your organization's standard tools. This makes pipeline creation faster and ensures consistency.
4. **Use the AI Script Generator**: For unfamiliar software, let the AI agent research silent install methods and generate tested scripts rather than writing them from scratch
5. **Set auto-shutdown policies**: Prevent runaway costs from forgotten workstations
6. **Monitor usage**: Review workstation utilization to optimize costs
7. **Use groups**: Simplify management by organizing users into groups
8. **Regular AMI updates**: Rebuild pipelines periodically to pick up security patches from updated base images
9. **Copy images to regional hubs**: If you have users in multiple regions, use the Copy to Region feature to reduce latency for workstation launches

### Keyboard Shortcuts (DCV)

| Shortcut | Action |
|----------|--------|
| `Ctrl+Alt+Enter` | Toggle fullscreen |
| `Ctrl+Alt+F12` | Open DCV menu |
| `Ctrl+Alt+Del` | Send Ctrl+Alt+Del to remote |

---

## Troubleshooting

### Can't Connect to Workstation

1. Verify the workstation is in "Running" state
2. Wait 2-3 minutes after starting for DCV to initialize
3. Try refreshing the page and clicking Connect again
4. Check with your administrator if the issue persists

### Workstation Won't Start

1. Check if you have permission to start the workstation
2. Verify EC2 service limits haven't been reached
3. Contact your administrator to check CloudWatch logs

### Slow Performance

1. Check your network connection
2. Try the native DCV client instead of browser
3. Verify the instance type is appropriate for your workload
4. Check if storage throughput is sufficient

### Session Disconnected

1. DCV sessions may timeout after inactivity
2. Click Connect to start a new session
3. Your work is preserved on the workstation

### Pipeline Build Failed

1. Go to **Pipelines** page and check the pipeline status
2. Common causes:
   - Installation script errors — check the script syntax and silent install flags
   - Insufficient disk space — increase the build instance type or reduce components
   - Network issues — the build instance needs access to download installers (S3, internet)
   - Timeout — large software installations may exceed the default timeout
3. Edit the pipeline to fix the failing component, then click **Build** to retry
4. For script-based components, use the **AI Script Generator** to analyze the error and generate a corrected script

### AI Script Generator Not Available

1. Verify `EnableBedrockFeatures` is set to `true` in your deployment configuration
2. Check that your AWS account has access to Amazon Bedrock in the deployed region
3. Some accounts may have SCPs (Service Control Policies) that restrict Bedrock access

---

## Getting Help

- **Technical Issues**: Contact your system administrator
- **Account Access**: Contact your IT helpdesk
- **Feature Requests**: Submit through your organization's request process
