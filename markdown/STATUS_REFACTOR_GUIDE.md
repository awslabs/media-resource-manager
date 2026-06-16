# Status Field Refactoring Implementation Guide

## Overview
Refactor status fields to separate EC2 instance state from workflow state tracking.

## Schema Changes
```typescript
// OLD
status: "pending" | "running" | "stopping" | "stopped" | "terminated"

// NEW  
instanceStatus: "pending" | "running" | "stopping" | "stopped" | "terminated"  // EC2 state
status: "creating" | "configuring" | "ready" | "starting" | "stopping"        // Workflow state
dcvStatus: "starting" | "configuring" | "ready" | "stopped"                   // DCV state
```

## Implementation Steps

### Phase 1: Backend Infrastructure
- [ ] 1. Update EventBridge stack to use `instanceStatus` instead of `status`
- [ ] 2. Update workstation creation stack to set initial `status: 'creating'`
- [ ] 3. Add progress tracking to creation workflow using `status` field
- [ ] 4. Update workstation start stack to use `status` for startup workflow

### Phase 2: API & Lambda Functions  
- [ ] 5. Update workstation management APIs to return both fields
- [ ] 6. Update any Lambda functions that read/write status fields
- [ ] 7. Update DCV status sync to use `instanceStatus` for EC2 checks

### Phase 3: Frontend
- [ ] 8. Update frontend to display both `instanceStatus` and `status`
- [ ] 9. Update connection logic: require `instanceStatus: 'running'` AND `status: 'ready'`
- [ ] 10. Update workstation list/dashboard to show appropriate status

### Phase 4: Migration & Testing
- [ ] 11. Create migration script for existing records (copy `status` → `instanceStatus`)
- [ ] 12. Test creation workflow end-to-end
- [ ] 13. Test start/stop workflow end-to-end
- [ ] 14. Verify EventBridge updates work correctly

## Status Workflow States

### Creation Workflow (`status` field)
- `launching` → EC2 instance being created
- `installing-dcv` → DCV installation in progress  
- `configuring-dcv` → DCV configuration
- `joining-domain` → Domain join in progress
- `configuring-system` → SSM commands, task scheduler setup
- `finalizing` → Final restart and verification
- `ready` → Fully configured and ready

### Startup Workflow (`status` field)  
- `starting-instance` → EC2 instance starting
- `starting-dcv` → DCV agents starting  
- `testing-dcv` → DCV connectivity test
- `ready` → Ready for connections

### EC2 States (`instanceStatus` field)
- `pending` → `running` → `stopping` → `stopped` → `terminated`

## Connection Logic
Frontend should allow connections only when:
- `instanceStatus === 'running'` 
- `status === 'ready'`
- `dcvStatus === 'ready'`

## Files to Modify
- `lib/eventbridge-stack.ts` - Update to use `instanceStatus`
- `lib/workstation-creation-stack.ts` - Add `status` workflow tracking
- `lib/workstation-start-stack.ts` - Update `status` usage
- `lib/workstation-management-stack.ts` - Update API responses
- `frontend/src/` - Update UI components
- Migration script for existing data

## Testing Checklist
- [ ] Create new workstation - verify status progression
- [ ] Start existing workstation - verify status updates  
- [ ] Stop workstation - verify status updates
- [ ] EventBridge EC2 state changes update `instanceStatus`
- [ ] Frontend shows correct status information
- [ ] Connection button only enabled when fully ready
