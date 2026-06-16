// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const { EC2Client, DescribeHostsCommand, AllocateHostsCommand } = require('@aws-sdk/client-ec2');
const ec2 = new EC2Client();

exports.handler = async (event) => {
    console.log('Allocating Dedicated Host for macOS:', JSON.stringify(event, null, 2));

    const { instanceType } = event;
    const availabilityZones = process.env.AVAILABILITY_ZONES.split(',');

    // First, check for existing available hosts
    try {
        const describeResult = await ec2.send(new DescribeHostsCommand({
            Filter: [
                { Name: 'instance-type', Values: [instanceType] },
                { Name: 'state', Values: ['available'] }
            ]
        }));

        const availableHosts = describeResult.Hosts?.filter(h =>
            h.AvailableCapacity?.AvailableInstanceCapacity?.some(c =>
                c.InstanceType === instanceType && c.AvailableCapacity > 0
            )
        ) || [];

        if (availableHosts.length > 0) {
            const host = availableHosts[0];
            console.log('Found existing available host:', host.HostId);
            return {
                ...event,
                dedicatedHostId: host.HostId,
                availabilityZone: host.AvailabilityZone,
                hostAllocated: true
            };
        }
    } catch (e) {
        console.warn('Error checking existing hosts:', e.message);
    }

    // No available host found, allocate a new one
    for (const az of availabilityZones) {
        try {
            console.log('Attempting to allocate host in', az);
            const allocateResult = await ec2.send(new AllocateHostsCommand({
                InstanceType: instanceType,
                Quantity: 1,
                AvailabilityZone: az,
                AutoPlacement: 'on',
                TagSpecifications: [{
                    ResourceType: 'dedicated-host',
                    Tags: [
                        { Key: 'Name', Value: 'macOS-Workstation-Host' },
                        { Key: 'ManagedBy', Value: process.env.PASCAL_CASE_NAME || 'WorkstationManager' },
                        { Key: 'InstanceType', Value: instanceType }
                    ]
                }]
            }));

            const hostId = allocateResult.HostIds[0];
            console.log('Allocated new host:', hostId, 'in', az);
            return {
                ...event,
                dedicatedHostId: hostId,
                availabilityZone: az,
                hostAllocated: true,
                newHostAllocated: true
            };
        } catch (e) {
            console.warn('Failed to allocate in', az, ':', e.message);
            if (!e.message.includes('capacity') && !e.message.includes('Capacity')) {
                throw e;
            }
        }
    }

    throw new Error('Unable to allocate Dedicated Host in any availability zone. macOS instances require Dedicated Hosts with 24-hour minimum allocation.');
};