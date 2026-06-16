// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Hostname Generator Lambda
 * 
 * Generates unique sequential hostnames using DynamoDB atomic counters.
 * This ensures no hostname collisions even with concurrent workstation creation.
 * 
 * Input: { platform: 'Windows' | 'Linux' | 'macOS' }
 * Output: { hostname: 'tegna-vdi-0001', hostnameNumber: 1 }
 */

const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');
const { DynamoDBDocumentClient, UpdateCommand, GetCommand } = require('@aws-sdk/lib-dynamodb');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');

const ssm = new SSMClient();
const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient());

exports.handler = async (event) => {
    console.log('Generating hostname:', JSON.stringify(event, null, 2));

    const pascalCaseName = process.env.PASCAL_CASE_NAME;
    const hostnameCounterTable = process.env.HOSTNAME_COUNTER_TABLE_NAME;

    // Get hostname configuration from SSM Parameter Store
    let hostnamePrefix = 'vdi-';
    let hostnameDigits = 4;

    try {
        const [prefixResult, digitsResult] = await Promise.all([
            ssm.send(new GetParameterCommand({ 
                Name: `/${pascalCaseName}/Workstation/HostnamePrefix` 
            })).catch(() => null),
            ssm.send(new GetParameterCommand({ 
                Name: `/${pascalCaseName}/Workstation/HostnameDigits` 
            })).catch(() => null)
        ]);

        if (prefixResult?.Parameter?.Value) {
            hostnamePrefix = prefixResult.Parameter.Value;
        }
        if (digitsResult?.Parameter?.Value) {
            hostnameDigits = parseInt(digitsResult.Parameter.Value, 10);
        }
    } catch (error) {
        console.warn('Could not fetch hostname config from SSM, using defaults:', error.message);
    }

    // Atomic increment of the counter using DynamoDB UpdateItem
    // This is thread-safe and handles concurrent requests correctly
    const updateResult = await dynamodb.send(new UpdateCommand({
        TableName: hostnameCounterTable,
        Key: { prefix: hostnamePrefix },
        UpdateExpression: 'SET #counter = if_not_exists(#counter, :zero) + :inc, lastUpdated = :now',
        ExpressionAttributeNames: {
            '#counter': 'counter'
        },
        ExpressionAttributeValues: {
            ':zero': 0,
            ':inc': 1,
            ':now': new Date().toISOString()
        },
        ReturnValues: 'UPDATED_NEW'
    }));

    const hostnameNumber = updateResult.Attributes.counter;
    const paddedNumber = hostnameNumber.toString().padStart(hostnameDigits, '0');
    const hostname = `${hostnamePrefix}${paddedNumber}`;

    console.log(`Generated hostname: ${hostname} (number: ${hostnameNumber})`);

    return {
        ...event,
        hostname,
        hostnameNumber,
        hostnamePrefix,
        hostnameDigits
    };
};

/**
 * Helper function to generate hostname - can be imported by instance-create lambdas
 * This allows hostname generation to happen inline during instance creation
 */
exports.generateHostname = async (pascalCaseName, hostnameCounterTable) => {
    // Get hostname configuration from SSM Parameter Store
    let hostnamePrefix = 'vdi-';
    let hostnameDigits = 4;

    try {
        const [prefixResult, digitsResult] = await Promise.all([
            ssm.send(new GetParameterCommand({ 
                Name: `/${pascalCaseName}/Workstation/HostnamePrefix` 
            })).catch(() => null),
            ssm.send(new GetParameterCommand({ 
                Name: `/${pascalCaseName}/Workstation/HostnameDigits` 
            })).catch(() => null)
        ]);

        if (prefixResult?.Parameter?.Value) {
            hostnamePrefix = prefixResult.Parameter.Value;
        }
        if (digitsResult?.Parameter?.Value) {
            hostnameDigits = parseInt(digitsResult.Parameter.Value, 10);
        }
    } catch (error) {
        console.warn('Could not fetch hostname config from SSM, using defaults:', error.message);
    }

    // Atomic increment of the counter
    const updateResult = await dynamodb.send(new UpdateCommand({
        TableName: hostnameCounterTable,
        Key: { prefix: hostnamePrefix },
        UpdateExpression: 'SET #counter = if_not_exists(#counter, :zero) + :inc, lastUpdated = :now',
        ExpressionAttributeNames: {
            '#counter': 'counter'
        },
        ExpressionAttributeValues: {
            ':zero': 0,
            ':inc': 1,
            ':now': new Date().toISOString()
        },
        ReturnValues: 'UPDATED_NEW'
    }));

    const hostnameNumber = updateResult.Attributes.counter;
    const paddedNumber = hostnameNumber.toString().padStart(hostnameDigits, '0');
    const hostname = `${hostnamePrefix}${paddedNumber}`;

    return { hostname, hostnameNumber, hostnamePrefix, hostnameDigits };
};
