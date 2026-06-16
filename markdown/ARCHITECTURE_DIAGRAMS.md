# AWS Media Resource Manager — Architecture Diagrams

## High-Level Application Architecture

This diagram shows the high-level API, authentication, workstation management, and frontend architecture of Media Resource Manager.

```mermaid
graph TB
    subgraph "AWS Cloud"
        subgraph "Region"
            subgraph "Frontend Layer"
                CF[Amazon CloudFront]
                S3F[Amazon S3<br/>Static Website]
            end

            subgraph "Authentication & Authorization Layer"
                COG[Amazon Cognito<br/>User Pool]
                AD[AWS Managed<br/>Active Directory]
                JWT[JWT Authorizer<br/>Lambda]
            end

            subgraph "API Layer"
                APIGW[Amazon API Gateway<br/>REST API]
                APILAMBDA[AWS Lambda<br/>Workstation API]
            end

            subgraph "Workstation Provisioning Layer"
                SFNWIN[AWS Step Functions<br/>Windows Creation]
                SFNLINUX[AWS Step Functions<br/>Linux Creation]
                SFNMAC[AWS Step Functions<br/>macOS Creation]
                SFNSTART[AWS Step Functions<br/>Workstation Start]
                CREATELAMBDA[AWS Lambda<br/>Create Instance]
                DOMJOIN[AWS Lambda<br/>Domain Join]
                DCVREADY[AWS Lambda<br/>DCV Readiness]
            end

            subgraph "DCV Session Layer"
                DCVGW[DCV Connection<br/>Gateway]
                DCVSM[DCV Session<br/>Manager]
                NLB[Network Load<br/>Balancer]
            end

            subgraph "Data Layer"
                DDB[Amazon DynamoDB<br/>Users, Workstations,<br/>AMIs, Groups]
                KMS[AWS KMS<br/>Data Encryption]
                SM[AWS Secrets<br/>Manager]
                SSM[AWS Systems Manager<br/>Parameter Store]
            end

            subgraph "Compute Layer"
                EC2WIN[EC2 Windows<br/>Workstations]
                EC2LIN[EC2 Linux<br/>Workstations]
                EC2MAC[EC2 macOS<br/>Workstations]
            end

            subgraph "Events & Monitoring Layer"
                EB[Amazon EventBridge<br/>EC2 State Changes,<br/>Auto-Shutdown]
                CW[Amazon CloudWatch<br/>Logs & Metrics]
            end
        end
    end

    USER((User)) -->|1. HTTPS| CF
    CF --> S3F
    USER -->|2. Authenticate| COG
    COG -.->|SAML/LDAP| AD
    USER -->|3. API Calls| APIGW
    APIGW -->|Authorize| JWT
    APIGW --> APILAMBDA
    APILAMBDA --> DDB
    APILAMBDA -->|Create| SFNWIN
    APILAMBDA -->|Create| SFNLINUX
    APILAMBDA -->|Create| SFNMAC
    APILAMBDA -->|Start| SFNSTART
    SFNWIN --> CREATELAMBDA
    SFNWIN --> DOMJOIN
    SFNWIN --> DCVREADY
    SFNLINUX --> CREATELAMBDA
    SFNLINUX --> DCVREADY
    CREATELAMBDA --> EC2WIN
    CREATELAMBDA --> EC2LIN
    CREATELAMBDA --> EC2MAC
    USER -->|4. DCV Connect| NLB
    NLB --> DCVGW
    DCVGW --> DCVSM
    DCVSM --> EC2WIN
    DCVSM --> EC2LIN
    DCVSM --> EC2MAC
    EB -->|Monitor| EC2WIN
    EB -->|Monitor| EC2LIN
    EB -->|Monitor| EC2MAC

    style CF fill:#8B5CF6,color:white
    style APIGW fill:#E97B2D,color:white
    style COG fill:#DD344C,color:white
    style DDB fill:#3B48CC,color:white
    style NLB fill:#8B5CF6,color:white
    style EB fill:#E97B2D,color:white

```

### Architecture Notes

1. **Users** access the web console through **Amazon CloudFront**, which serves the React application from **Amazon S3**.
2. **Amazon Cognito** handles user authentication with support for SAML federation (Okta, IAM Identity Center) or LDAP via **AWS Managed Active Directory**.
3. **API Gateway** routes authenticated requests through a **JWT Authorizer Lambda** to the **Workstation API Lambda**, which manages all CRUD operations against **DynamoDB**.
4. Workstation creation is orchestrated by **AWS Step Functions** workflows (separate for Windows, Linux, and macOS), which invoke Lambda functions for instance creation, domain joining, and DCV readiness checks.
5. Users connect to workstations via **Amazon DCV** through a **Network Load Balancer** → **DCV Connection Gateway** → **DCV Session Manager** path.
6. **Amazon EventBridge** monitors EC2 state changes, enforces auto-shutdown policies, and triggers authentication mode updates.
7. All sensitive data is encrypted with **AWS KMS** customer-managed keys. Credentials are stored in **AWS Secrets Manager**.

---

## Workstation Provisioning Workflow

This diagram shows the Step Functions workflow for creating a new workstation.

```mermaid
graph TD
    START((Start)) --> CREATE[Create EC2 Instance<br/>Lambda]
    CREATE --> WAIT1[Wait for<br/>Instance Running]
    WAIT1 --> CHECK1{Instance<br/>Running?}
    CHECK1 -->|No| WAIT1
    CHECK1 -->|Yes| SSM[Check SSM<br/>Readiness]
    SSM --> WAIT2[Wait for<br/>SSM Agent]
    WAIT2 --> CHECK2{SSM<br/>Ready?}
    CHECK2 -->|No| WAIT2
    CHECK2 -->|Yes| HOSTNAME[Set Hostname<br/>Lambda]
    HOSTNAME --> DOMAIN{Join<br/>Domain?}
    DOMAIN -->|Yes| DOMAINJOIN[Domain Join<br/>via SSM]
    DOMAIN -->|No| INSTALL
    DOMAINJOIN --> DJCHECK{Domain Join<br/>Complete?}
    DJCHECK -->|No| DJWAIT[Wait] --> DJCHECK
    DJCHECK -->|Yes| REBOOT[Reboot<br/>Instance]
    REBOOT --> WAITREBOOT[Wait for<br/>Reboot]
    WAITREBOOT --> INSTALL[Install Software<br/>via SSM]
    INSTALL --> INSTALLCHECK{Install<br/>Complete?}
    INSTALLCHECK -->|No| INSTALLWAIT[Wait] --> INSTALLCHECK
    INSTALLCHECK -->|Yes| DCV[Check DCV<br/>Readiness]
    DCV --> DCVCHECK{DCV<br/>Ready?}
    DCVCHECK -->|No| DCVWAIT[Wait] --> DCVCHECK
    DCVCHECK -->|Yes| UPDATE[Update DynamoDB<br/>Status: Ready]
    UPDATE --> DONE((Complete))

    CHECK1 -->|Failed| FAIL((Failed))
    CHECK2 -->|Timeout| FAIL
    DJCHECK -->|Failed| FAIL
    INSTALLCHECK -->|Failed| FAIL
    DCVCHECK -->|Timeout| FAIL

    style START fill:#22C55E,color:white
    style DONE fill:#22C55E,color:white
    style FAIL fill:#EF4444,color:white
    style CREATE fill:#E97B2D,color:white
    style DOMAINJOIN fill:#E97B2D,color:white
    style DCV fill:#8B5CF6,color:white
```

### Workflow Notes

1. **Create EC2 Instance** — Launches the instance with the selected AMI, instance type, and security group. Assigns a unique hostname from the DynamoDB counter.
2. **SSM Readiness** — Waits for the SSM agent to come online so subsequent commands can be sent.
3. **Hostname Assignment** — Sets the machine hostname using an atomic DynamoDB counter (e.g., `vdi-0001`).
4. **Domain Join** (Windows only, optional) — Joins the instance to AWS Managed Active Directory via SSM `AWS-JoinDirectoryServiceDomain`.
5. **Software Installation** — Runs SSM commands to install additional software from the image pipeline configuration.
6. **DCV Readiness** — Verifies the DCV agent is running and the session can be created.

---

## DCV Connection Architecture

This diagram shows how users connect to workstations via Amazon DCV.

```mermaid
graph LR
    subgraph "Client"
        BROWSER[Web Browser<br/>DCV Web Client]
        NATIVE[DCV Native<br/>Client]
    end

    subgraph "AWS Cloud"
        subgraph "Public Subnet"
            NLB2[Network Load<br/>Balancer<br/>TCP 8443]
        end

        subgraph "Private Subnet"
            GW[DCV Connection<br/>Gateway<br/>EC2 Instance]
            SM2[DCV Session<br/>Manager<br/>EC2 Instance]
        end

        subgraph "Workstation Subnet"
            WS1[Windows<br/>Workstation<br/>DCV Agent]
            WS2[Linux<br/>Workstation<br/>DCV Agent]
            WS3[macOS<br/>Workstation<br/>DCV Agent]
        end

        DDB2[DynamoDB<br/>Session State]
        SSM2[SSM Parameters<br/>DCV Config]
    end

    BROWSER -->|HTTPS :8443| NLB2
    NATIVE -->|TCP/UDP :8443| NLB2
    NLB2 --> GW
    GW -->|Session Routing| SM2
    SM2 -->|Manage Sessions| WS1
    SM2 -->|Manage Sessions| WS2
    SM2 -->|Manage Sessions| WS3
    SM2 -.->|Session State| DDB2
    GW -.->|Config| SSM2

    style NLB2 fill:#8B5CF6,color:white
    style GW fill:#E97B2D,color:white
    style SM2 fill:#E97B2D,color:white
    style DDB2 fill:#3B48CC,color:white
```

### Connection Notes

1. Users connect via **web browser** (WebSocket over HTTPS) or the **DCV native client** (TCP/UDP with QUIC support for lower latency).
2. The **Network Load Balancer** terminates TLS and routes traffic to the **DCV Connection Gateway**.
3. The **Connection Gateway** authenticates the session token and routes the connection to the correct workstation via the **Session Manager**.
4. The **Session Manager** tracks active sessions, manages session lifecycle, and coordinates with DCV agents on each workstation.
5. **QUIC protocol** (UDP 8443-8444) provides lower latency for the native client. NACLs must allow UDP traffic for this to work.

---

## Authentication Flows

```mermaid
graph TD
    subgraph "Cognito Mode (SAML)"
        U1((User)) -->|1| FE1[Frontend<br/>Login Page]
        FE1 -->|2. Redirect| HOSTED[Cognito<br/>Hosted UI]
        HOSTED -->|3. SAML| IDP[Identity Provider<br/>Okta / IAM IdC]
        IDP -->|4. SAML Assertion| HOSTED
        HOSTED -->|5. JWT Tokens| FE1
        FE1 -->|6. API + JWT| API1[API Gateway]
        API1 -->|7. Validate| JWTL1[JWT Authorizer]
    end

    subgraph "LDAP Mode"
        U2((User)) -->|1| FE2[Frontend<br/>Login Page]
        FE2 -->|2. Username/Password| API2[API Gateway<br/>/auth/ldap]
        API2 --> LDAP[LDAP Auth<br/>Lambda]
        LDAP -->|3. LDAP Bind| MAD[AWS Managed<br/>Active Directory]
        MAD -->|4. Auth Result| LDAP
        LDAP -->|5. Generate JWT| FE2
        FE2 -->|6. API + JWT| API3[API Gateway]
        API3 -->|7. Validate| JWTL2[JWT Authorizer]
    end

    style HOSTED fill:#DD344C,color:white
    style IDP fill:#F59E0B,color:white
    style MAD fill:#3B48CC,color:white
    style LDAP fill:#E97B2D,color:white
```

### Authentication Notes

- **Cognito Mode**: Users are redirected to the Cognito Hosted UI, which federates to the configured SAML provider (Okta or IAM Identity Center). After authentication, Cognito issues JWT tokens used for API authorization.
- **LDAP Mode**: Users enter credentials directly in the frontend. The LDAP Auth Lambda binds to AWS Managed Active Directory to verify credentials, then issues a JWT token.
- **Mode Switching**: Authentication mode is controlled via SSM Parameter Store. EventBridge automation updates the frontend configuration when the mode changes.

---

## Storage Architecture (FSx Integration)

```mermaid
graph TB
    subgraph "Management"
        ADMIN((Admin)) --> CONSOLE[Web Console<br/>Storage Page]
        CONSOLE --> API[API Gateway<br/>Storage Endpoints]
        API --> SLAMBDA[Storage Lambda<br/>Functions]
    end

    subgraph "Storage Resources"
        SLAMBDA -->|Create/Manage| FSXW[FSx for Windows<br/>File Server]
        SLAMBDA -->|Create/Manage| FSXN[FSx for NetApp<br/>ONTAP]
        SLAMBDA -->|Sync| DSYNC[AWS DataSync<br/>S3 ↔ FSx]
    end

    subgraph "Workstations"
        WS4[Windows<br/>Workstation]
        WS5[Linux<br/>Workstation]
    end

    subgraph "Data Sources"
        S3B[Amazon S3<br/>Media Bucket]
    end

    FSXW -->|SMB Mount| WS4
    FSXN -->|NFS/SMB Mount| WS4
    FSXN -->|NFS Mount| WS5
    DSYNC --> S3B
    DSYNC --> FSXN

    DDB3[DynamoDB<br/>Storage Table] -.-> SLAMBDA

    style FSXW fill:#3B48CC,color:white
    style FSXN fill:#3B48CC,color:white
    style DSYNC fill:#E97B2D,color:white
    style S3B fill:#22C55E,color:white
```

### Storage Notes

1. Administrators create and manage storage resources (FSx file systems) through the web console.
2. **FSx for Windows File Server** provides SMB shares for Windows workstations, integrated with Active Directory.
3. **FSx for NetApp ONTAP** supports both NFS and SMB, works with both Windows and Linux workstations without requiring AD.
4. **AWS DataSync** synchronizes data between S3 media buckets and FSx file systems.
5. Mount scripts are automatically deployed to workstations at login via SSM, mapping network drives to the assigned storage.

---

## Stack Deployment Architecture

```mermaid
graph TD
    subgraph "Infrastructure Foundation"
        S1[MRM-Infrastructure<br/>VPC, AD, DynamoDB,<br/>Cognito, KMS, ImageBuilder]
    end

    subgraph "DCV Platform"
        S2[MRM-Dcv-Infrastructure<br/>Session Manager,<br/>Connection Gateway, NLB]
        S3[MRM-Dcv-Cleanup<br/>Session Cleanup]
        S4[MRM-Dcv-StatusSync<br/>Connection Monitoring]
    end

    subgraph "Workstation Provisioning"
        S5[MRM-Workstation-Windows<br/>Step Functions Workflow]
        S6[MRM-Workstation-Linux<br/>Step Functions Workflow]
        S7[MRM-Workstation-MacOS<br/>Step Functions Workflow]
        S8[MRM-Image-MacOS<br/>Base Image Pipeline]
        S9[MRM-Workstation-Start<br/>Start Workflow]
    end

    subgraph "API & Management"
        S10[MRM-Storage<br/>FSx Management]
        S11[MRM-Api<br/>API Gateway, Lambda]
    end

    subgraph "Frontend & Events"
        S12[MRM-Frontend<br/>S3, CloudFront]
        S13[MRM-Events<br/>EventBridge Rules]
    end

    S1 --> S2
    S1 --> S3
    S1 --> S4
    S1 --> S5
    S1 --> S6
    S1 --> S7
    S1 --> S8
    S1 --> S9
    S1 --> S10
    S2 --> S11
    S5 --> S11
    S6 --> S11
    S7 --> S11
    S9 --> S11
    S10 --> S11
    S11 --> S12
    S11 --> S13

    style S1 fill:#3B48CC,color:white
    style S2 fill:#8B5CF6,color:white
    style S11 fill:#E97B2D,color:white
    style S12 fill:#22C55E,color:white
```

### Deployment Notes

- **13 specialized stacks** deployed in dependency order for modularity and independent updates.
- **MRM-Infrastructure** is the foundation — all other stacks depend on it for VPC, database, identity, and encryption resources.
- **MRM-Api** is the central hub — it depends on the DCV and workstation stacks for their Step Functions ARNs.
- Stacks can be updated independently. For example, updating the frontend doesn't require redeploying the infrastructure.

---

## AWS Services Used

| Category | Services |
|----------|----------|
| Compute | EC2 (Windows, Linux, macOS), Lambda, Step Functions |
| Networking | VPC, NLB, CloudFront, Route 53 Resolver |
| Remote Desktop | Amazon DCV (Connection Gateway, Session Manager) |
| Database | DynamoDB |
| Storage | S3, FSx for Windows, FSx for NetApp ONTAP |
| Identity | Cognito, AWS Managed Active Directory, IAM |
| Security | KMS, Secrets Manager, Security Groups, NACLs |
| Integration | API Gateway, EventBridge, SSM Parameter Store |
| Imaging | EC2 Image Builder |
| Data Transfer | AWS DataSync |
| Monitoring | CloudWatch Logs & Metrics |
