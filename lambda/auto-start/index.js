// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, ScanCommand, QueryCommand } = require('@aws-sdk/lib-dynamodb');
const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');
const { SFNClient, StartExecutionCommand } = require('@aws-sdk/client-sfn');

const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient());
const ssm = new SSMClient();
const sfn = new SFNClient();

exports.handler = async (event) => {
  console.log('Starting auto-start check...');

  try {
    const pascalCaseName = process.env.PASCAL_CASE_NAME || 'MediaResourceManager';
    
    // Check if auto-start is enabled
    let autoStartEnabled = false;
    try {
      const param = await ssm.send(new GetParameterCommand({
        Name: `/${pascalCaseName}/Settings/AutoStartEnabled`
      }));
      autoStartEnabled = param.Parameter.Value === 'true';
    } catch (error) {
      if (error.name === 'ParameterNotFound') {
        console.log('Auto-start not configured - skipping');
        return { statusCode: 200, body: 'Auto-start not enabled' };
      }
      throw error;
    }

    if (!autoStartEnabled) {
      console.log('Auto-start is disabled - skipping');
      return { statusCode: 200, body: 'Auto-start disabled' };
    }

    // Get lead time setting
    let leadTimeMinutes = 15;
    try {
      const param = await ssm.send(new GetParameterCommand({
        Name: `/${pascalCaseName}/Settings/AutoStartLeadTimeMinutes`
      }));
      leadTimeMinutes = parseInt(param.Parameter.Value) || 15;
    } catch (error) {
      if (error.name !== 'ParameterNotFound') {
        console.log('Error getting lead time:', error);
      }
    }

    console.log(`Auto-start enabled with ${leadTimeMinutes} minute lead time`);

    // Get current time
    const now = new Date();
    
    // Scan users table for users with schedules
    const usersResult = await dynamodb.send(new ScanCommand({
      TableName: process.env.USER_TABLE_NAME,
      FilterExpression: 'attribute_exists(autoStartSchedule) AND autoStartSchedule.enabled = :enabled',
      ExpressionAttributeValues: {
        ':enabled': true
      }
    }));

    const usersWithSchedules = usersResult.Items || [];
    console.log(`Found ${usersWithSchedules.length} users with active schedules`);

    let startedCount = 0;
    let skippedCount = 0;

    for (const user of usersWithSchedules) {
      const { userId, autoStartSchedule } = user;
      const { timezone, schedule } = autoStartSchedule;

      // Get current time in user's timezone
      const userTime = getTimeInTimezone(now, timezone);
      const dayOfWeek = getDayOfWeek(now, timezone);
      const currentMinutes = userTime.hours * 60 + userTime.minutes;
      
      // Check today's schedule first
      let scheduledTime = schedule[dayOfWeek];
      let targetMinutes = null;
      
      if (scheduledTime) {
        const [scheduledHour, scheduledMinute] = scheduledTime.split(':').map(Number);
        targetMinutes = scheduledHour * 60 + scheduledMinute - leadTimeMinutes;
        
        // If target time is negative, it means we need to start the previous day
        // So this schedule entry doesn't apply to today's Lambda run
        if (targetMinutes < 0) {
          targetMinutes = null;
        }
      }
      
      // Also check if tomorrow's schedule requires starting today (for schedules near midnight)
      // e.g., tomorrow at 00:00 with 20 min lead time = today at 23:40
      if (targetMinutes === null || currentMinutes > 1400) { // After 23:20, check tomorrow
        const tomorrow = getNextDayOfWeek(dayOfWeek);
        const tomorrowScheduledTime = schedule[tomorrow];
        
        if (tomorrowScheduledTime) {
          const [tomorrowHour, tomorrowMinute] = tomorrowScheduledTime.split(':').map(Number);
          const tomorrowTargetMinutes = tomorrowHour * 60 + tomorrowMinute - leadTimeMinutes;
          
          // If tomorrow's target is negative, it means start today (wrap around)
          if (tomorrowTargetMinutes < 0) {
            const wrappedTargetMinutes = 1440 + tomorrowTargetMinutes; // 1440 = minutes in a day
            if (targetMinutes === null || wrappedTargetMinutes > targetMinutes) {
              targetMinutes = wrappedTargetMinutes;
              scheduledTime = tomorrowScheduledTime;
            }
          }
        }
      }
      
      if (targetMinutes === null) {
        continue;
      }

      // Check if we're within the 5-minute window to start
      // (Lambda runs every 5 minutes, so we check if current time is within 5 minutes of target)
      const timeDiff = currentMinutes - targetMinutes;
      
      if (timeDiff >= 0 && timeDiff < 5) {
        console.log(`User ${userId}: Time to start workstations (scheduled: ${scheduledTime}, timezone: ${timezone})`);
        
        // Find workstations assigned to this user
        const workstationsResult = await dynamodb.send(new QueryCommand({
          TableName: process.env.WORKSTATION_TABLE_NAME,
          IndexName: 'user-assignment-index',
          KeyConditionExpression: 'assignedUserId = :userId',
          ExpressionAttributeValues: {
            ':userId': userId
          }
        }));

        const workstations = workstationsResult.Items || [];
        console.log(`Found ${workstations.length} workstations for user ${userId}`);

        for (const workstation of workstations) {
          const { instanceId, instanceStatus } = workstation;
          
          // Only start stopped workstations
          if (instanceStatus === 'stopped') {
            console.log(`Starting workstation ${instanceId} for user ${userId}`);
            
            try {
              // Start the workstation via Step Functions
              await sfn.send(new StartExecutionCommand({
                stateMachineArn: process.env.START_STATE_MACHINE_ARN,
                name: `auto-start-${instanceId}-${Date.now()}`,
                input: JSON.stringify({ instanceId })
              }));
              
              startedCount++;
              console.log(`Started workstation ${instanceId}`);
            } catch (error) {
              console.error('Failed to start workstation', instanceId + ':', error.message);
            }
          } else {
            console.log(`Workstation ${instanceId} is ${instanceStatus}, skipping`);
            skippedCount++;
          }
        }
      }
    }

    console.log(`Auto-start completed: ${startedCount} workstations started, ${skippedCount} skipped`);
    
    return {
      statusCode: 200,
      body: JSON.stringify({
        message: 'Auto-start check completed',
        usersChecked: usersWithSchedules.length,
        workstationsStarted: startedCount,
        workstationsSkipped: skippedCount
      })
    };

  } catch (error) {
    console.error('Auto-start error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message })
    };
  }
};

// Helper function to get current time in a specific timezone
function getTimeInTimezone(date, timezone) {
  try {
    const options = {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    };
    const timeStr = date.toLocaleTimeString('en-US', options);
    const [hours, minutes] = timeStr.split(':').map(Number);
    return { hours, minutes };
  } catch (error) {
    console.error(`Invalid timezone ${timezone}, using UTC`);
    return { hours: date.getUTCHours(), minutes: date.getUTCMinutes() };
  }
}

// Helper function to get day of week in a specific timezone
function getDayOfWeek(date, timezone) {
  try {
    const options = {
      timeZone: timezone,
      weekday: 'long'
    };
    return date.toLocaleDateString('en-US', options).toLowerCase();
  } catch (error) {
    console.error(`Invalid timezone ${timezone}, using UTC`);
    const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    return days[date.getUTCDay()];
  }
}

// Helper function to get the next day of week
function getNextDayOfWeek(currentDay) {
  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const currentIndex = days.indexOf(currentDay);
  return days[(currentIndex + 1) % 7];
}
