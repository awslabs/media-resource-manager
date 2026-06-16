// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { apiCall } from './api';
import { getAuthToken } from './auth';

export interface DcvSession {
  Id: string;
  Name?: string;
  Owner: string;
  Type: string;
  State: string;
  CreationTime: string;
  NumOfConnections?: number;
  Server?: {
    Id: string;
  };
}

export interface DcvServer {
  Id: string;
  Host?: {
    Aws?: {
      EC2InstanceId: string;
    };
  };
}

export class DcvApiService {
  private static async makeApiCall(action: string, additionalParams: any = {}) {
    const token = getAuthToken();
    if (!token) {
      throw new Error('No current user');
    }

    const response = await apiCall('/dcv', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ action, ...additionalParams })
    });

    if (!response.ok) {
      throw new Error(`DCV API call failed: ${response.status}`);
    }

    return response.json();
  }

  static async describeSessions(): Promise<DcvSession[]> {
    const data = await this.makeApiCall('describe-sessions');
    console.log('DCV API raw response:', data);
    const sessions = data.Sessions || data.sessions || [];
    console.log('Extracted sessions:', sessions);
    return sessions;
  }

  static async describeServers(): Promise<DcvServer[]> {
    const data = await this.makeApiCall('describe-servers');
    return data.servers || [];
  }

  static async getLoadBalancers() {
    return this.makeApiCall('get-load-balancers');
  }

  static async getAutoScalingGroups() {
    return this.makeApiCall('get-autoscaling-groups');
  }

  static async getWorkstationAssignments() {
    return this.makeApiCall('get-workstation-assignments');
  }

  static async getInstanceStates() {
    return this.makeApiCall('get-instance-states');
  }

  static async deleteSession(sessionId: string) {
    return this.makeApiCall('delete-session', { sessionId });
  }

  static async getSessionsForUser(userId: string): Promise<DcvSession[]> {
    const sessions = await this.describeSessions();
    console.log('All sessions from describeSessions:', sessions);
    const userSessions = sessions.filter(session => {
      console.log(`Comparing session owner "${session.Owner}" with userId "${userId}"`);
      return session.Owner === userId;
    });
    console.log('Filtered user sessions:', userSessions);
    return userSessions;
  }
}
