// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import * as fs from 'fs';
import * as path from 'path';

interface NetworkParams {
  VpcId?: string;
  VpcCidr?: string;
  AvailabilityZones?: string;
  PublicSubnetMask?: string;
  PrivateSubnetMask?: string;
  PrivateSubnetIds?: string;
  PublicSubnetIds?: string;
  PrivateRouteTableIds?: string;
  PublicRouteTableIds?: string;
}

export interface NetworkConstructProps {
  pascalCaseName: string;
}

export class NetworkConstruct extends Construct {
  public readonly vpc: ec2.IVpc;
  public readonly privateSubnets: ec2.ISubnet[];
  public readonly publicSubnets: ec2.ISubnet[];
  public readonly privateRouteTableIds: string[];
  private readonly vpcCidr: string;
  private readonly isImportedWithExplicitSubnets: boolean;

  constructor(scope: Construct, id: string, props: NetworkConstructProps) {
    super(scope, id);

    const params = this.loadParameters();
    const hasExistingVpc = !!params.VpcId;
    this.isImportedWithExplicitSubnets = false;

    if (hasExistingVpc) {
      // Check if explicit subnet IDs are provided (for VPCs with multiple subnets per AZ)
      const privateSubnetIds = params.PrivateSubnetIds?.split(',').map(s => s.trim()).filter(s => s);
      const publicSubnetIds = params.PublicSubnetIds?.split(',').map(s => s.trim()).filter(s => s);
      const azList = params.AvailabilityZones?.split(',').map(s => s.trim()).filter(s => s);
      
      // VPC CIDR is required for imported VPCs - should be set by analyze-vpc.sh
      this.vpcCidr = params.VpcCidr || '10.0.0.0/16';
      
      if (privateSubnetIds && privateSubnetIds.length > 0 && azList && azList.length > 0) {
        // Use explicit subnet IDs - this handles VPCs with multiple subnets per AZ
        // We use fromVpcAttributes to avoid the lookup which would return all subnets
        this.isImportedWithExplicitSubnets = true;
        
        this.vpc = ec2.Vpc.fromVpcAttributes(this, 'ImportedVpc', {
          vpcId: params.VpcId!,
          availabilityZones: azList,
          privateSubnetIds: privateSubnetIds,
          publicSubnetIds: publicSubnetIds || [],
          vpcCidrBlock: this.vpcCidr,
        });
        
        // Manually create subnet references
        this.privateSubnets = privateSubnetIds.map((subnetId, index) => 
          ec2.Subnet.fromSubnetAttributes(this, `PrivateSubnet${index + 1}`, {
            subnetId: subnetId,
            availabilityZone: azList[index % azList.length],
          })
        );
        
        this.publicSubnets = (publicSubnetIds || []).map((subnetId, index) =>
          ec2.Subnet.fromSubnetAttributes(this, `PublicSubnet${index + 1}`, {
            subnetId: subnetId,
            availabilityZone: azList[index % azList.length],
          })
        );
      } else {
        // Standard VPC lookup - works for VPCs with one subnet per AZ
        this.vpc = ec2.Vpc.fromLookup(this, 'ImportedVpc', {
          vpcId: params.VpcId!,
        });
        this.vpcCidr = this.vpc.vpcCidrBlock;
        this.privateSubnets = this.vpc.privateSubnets;
        this.publicSubnets = this.vpc.publicSubnets;
      }
    } else {
      // Parse configuration from parameters
      const vpcCidr = params.VpcCidr || '10.0.0.0/16';
      const publicSubnetMask = parseInt(params.PublicSubnetMask || '28', 10);
      const privateSubnetMask = parseInt(params.PrivateSubnetMask || '24', 10);
      
      // Parse availability zones - default to 3 AZs if not specified
      const azList = params.AvailabilityZones 
        ? params.AvailabilityZones.split(',').map(az => az.trim()).filter(az => az)
        : undefined;

      // Create VPC with configurable subnet sizing
      // Note: Use either availabilityZones (explicit list) OR maxAzs (auto-select), not both
      this.vpc = new ec2.Vpc(this, 'CreatedVpc', {
        ipAddresses: ec2.IpAddresses.cidr(vpcCidr),
        ...(azList ? { availabilityZones: azList } : { maxAzs: 3 }),
        subnetConfiguration: [
          {
            cidrMask: publicSubnetMask,
            name: 'Public',
            subnetType: ec2.SubnetType.PUBLIC,
          },
          {
            cidrMask: privateSubnetMask,
            name: 'Private',
            subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          },
        ],
        // Create NAT Gateway in each AZ for high availability
        natGateways: azList?.length || 3,
      });
      
      this.vpcCidr = vpcCidr;
      this.privateSubnets = this.vpc.privateSubnets;
      this.publicSubnets = this.vpc.publicSubnets;
    }

    // Ensure privateSubnets and publicSubnets are set (for created VPC case)
    if (!this.privateSubnets) {
      this.privateSubnets = this.vpc.privateSubnets;
    }
    if (!this.publicSubnets) {
      this.publicSubnets = this.vpc.publicSubnets;
    }

    // Load private route table IDs from parameters (for imported VPCs)
    // These are captured by analyze-vpc.sh and used for VPC endpoint association
    const routeTableIdsParam = params.PrivateRouteTableIds;
    this.privateRouteTableIds = routeTableIdsParam
      ? routeTableIdsParam.split(',').map(s => s.trim()).filter(s => s)
      : [];

    // Store network info in SSM
    this.createSSMParameters(props);
  }

  private loadParameters(): NetworkParams {
    const paramsPath = path.join(process.cwd(), 'parameters.json');
    if (!fs.existsSync(paramsPath)) return {};

    const paramsArray = JSON.parse(fs.readFileSync(paramsPath, 'utf8'));
    return paramsArray.reduce((acc: NetworkParams, param: any) => {
      acc[param.ParameterKey as keyof NetworkParams] = param.ParameterValue;
      return acc;
    }, {});
  }

  private createSSMParameters(props: NetworkConstructProps) {
    // VPC parameters
    new ssm.StringParameter(this, 'VpcIdParameter', {
      parameterName: `/${props.pascalCaseName}/Network/VpcId`,
      stringValue: this.vpc.vpcId,
      description: 'VPC ID',
    });

    new ssm.StringParameter(this, 'VpcCidrParameter', {
      parameterName: `/${props.pascalCaseName}/Network/VpcCidr`,
      stringValue: this.vpcCidr,
      description: 'VPC CIDR block',
    });

    // Store all private subnet info dynamically
    this.privateSubnets.forEach((subnet, index) => {
      const subnetNum = index + 1;
      new ssm.StringParameter(this, `PrivateSubnet${subnetNum}SubnetIdParameter`, {
        parameterName: `/${props.pascalCaseName}/Network/PrivateSubnet${subnetNum}/SubnetID`,
        stringValue: subnet.subnetId,
        description: `Private Subnet ${subnetNum} ID`,
      });

      new ssm.StringParameter(this, `PrivateSubnet${subnetNum}AzParameter`, {
        parameterName: `/${props.pascalCaseName}/Network/PrivateSubnet${subnetNum}/AZ`,
        stringValue: subnet.availabilityZone,
        description: `Private Subnet ${subnetNum} Availability Zone`,
      });

      // Route table info is only available for non-imported subnets
      if (!this.isImportedWithExplicitSubnets) {
        new ssm.StringParameter(this, `PrivateSubnet${subnetNum}RouteTableParameter`, {
          parameterName: `/${props.pascalCaseName}/Network/PrivateSubnet${subnetNum}/RouteTableID`,
          stringValue: subnet.routeTable.routeTableId,
          description: `Private Subnet ${subnetNum} Route Table ID`,
        });
      }
    });

    // Store all public subnet info dynamically
    this.publicSubnets.forEach((subnet, index) => {
      const subnetNum = index + 1;
      new ssm.StringParameter(this, `PublicSubnet${subnetNum}SubnetIdParameter`, {
        parameterName: `/${props.pascalCaseName}/Network/PublicSubnet${subnetNum}/SubnetID`,
        stringValue: subnet.subnetId,
        description: `Public Subnet ${subnetNum} ID`,
      });

      new ssm.StringParameter(this, `PublicSubnet${subnetNum}AzParameter`, {
        parameterName: `/${props.pascalCaseName}/Network/PublicSubnet${subnetNum}/AZ`,
        stringValue: subnet.availabilityZone,
        description: `Public Subnet ${subnetNum} Availability Zone`,
      });

      // Route table info is only available for non-imported subnets
      if (!this.isImportedWithExplicitSubnets) {
        new ssm.StringParameter(this, `PublicSubnet${subnetNum}RouteTableParameter`, {
          parameterName: `/${props.pascalCaseName}/Network/PublicSubnet${subnetNum}/RouteTableID`,
          stringValue: subnet.routeTable.routeTableId,
          description: `Public Subnet ${subnetNum} Route Table ID`,
        });
      }
    });

    // Store subnet count for consumers that need to iterate
    new ssm.StringParameter(this, 'PrivateSubnetCountParameter', {
      parameterName: `/${props.pascalCaseName}/Network/PrivateSubnetCount`,
      stringValue: this.privateSubnets.length.toString(),
      description: 'Number of private subnets',
    });

    new ssm.StringParameter(this, 'PublicSubnetCountParameter', {
      parameterName: `/${props.pascalCaseName}/Network/PublicSubnetCount`,
      stringValue: this.publicSubnets.length.toString(),
      description: 'Number of public subnets',
    });

    // Store comma-separated lists for easy consumption
    new ssm.StringParameter(this, 'PrivateSubnetIdsParameter', {
      parameterName: `/${props.pascalCaseName}/Network/PrivateSubnetIds`,
      stringValue: this.privateSubnets.map(s => s.subnetId).join(','),
      description: 'Comma-separated list of private subnet IDs',
    });

    new ssm.StringParameter(this, 'PublicSubnetIdsParameter', {
      parameterName: `/${props.pascalCaseName}/Network/PublicSubnetIds`,
      stringValue: this.publicSubnets.map(s => s.subnetId).join(','),
      description: 'Comma-separated list of public subnet IDs',
    });

    new ssm.StringParameter(this, 'AvailabilityZonesParameter', {
      parameterName: `/${props.pascalCaseName}/Network/AvailabilityZones`,
      stringValue: [...new Set(this.privateSubnets.map(s => s.availabilityZone))].join(','),
      description: 'Comma-separated list of availability zones in use',
    });

    // Outputs
    new cdk.CfnOutput(this, 'VpcIdOutput', {
      value: this.vpc.vpcId,
      description: 'VPC ID',
    });

    new cdk.CfnOutput(this, 'VpcCidrOutput', {
      value: this.vpcCidr,
      description: 'VPC CIDR block',
    });

    new cdk.CfnOutput(this, 'AvailabilityZonesOutput', {
      value: [...new Set(this.privateSubnets.map(s => s.availabilityZone))].join(','),
      description: 'Availability zones in use',
    });

    new cdk.CfnOutput(this, 'PrivateSubnetCountOutput', {
      value: this.privateSubnets.length.toString(),
      description: 'Number of private subnets',
    });
  }
}
