# Status Field Usage Audit

## Current Status Field Usage

### Backend Usage

#### 1. EventBridge Stack (`lib/eventbridge-stack.ts`)
- **CRITICAL**: Updates `status` field based on EC2 instance state changes
- Lines 90-95: `SET #status = :status` for running instances  
- Lines 104-105: `SET #status = :status` for non-running instances
- **Impact**: This is the main system that manages the `status` field

#### 2. Workstation Creation Stack (`lib/workstation-creation-stack.ts`)
- Lines 80, 98: Sets initial `status: 'pending'` when creating workstations
- **Impact**: Sets initial status value

#### 3. Database Schema (`lib/constructs/database-construct.ts`)
- Lines 22-24: GSI `status-index` for querying by status
- **Impact**: Database index depends on this field

#### 4. Cleanup Construct (`lib/constructs/cleanup-construct.ts`)
- Line 25: `FilterExpression: '#status <> :terminated'`
- **Impact**: Cleanup logic filters by status

#### 5. Storage Stack (`lib/storage-stack.ts`)
- Multiple lines: Updates storage `status` field (different table)
- **Impact**: Separate usage for storage resources

#### 6. Auto-shutdown (`lib/eventbridge-stack.ts`)
- Line 205: `FilterExpression: '#status = :running'`
- **Impact**: Auto-shutdown queries running workstations

### Frontend Usage

#### 1. WorkstationManagement.tsx
- **Display**: Shows status in table columns and filters
- **Logic**: 
  - Lines 174-175: Checks transitional states `['pending', 'starting', 'stopping']`
  - Lines 748-762: `getStatusIndicator()` function maps status to UI indicators
  - Lines 1060, 1065: Button states depend on `status === 'stopped'` or `'running'`
  - Lines 994-998: Filter options for status values

#### 2. Dashboard.tsx  
- **Display**: Shows status in workstation cards
- **Logic**:
  - Lines 81-82: Checks transitional states (same as WorkstationManagement)
  - Lines 322-336: Same `getStatusIndicator()` function
  - Lines 366, 371, 378, 383: Action buttons depend on status
  - Lines 401, 409: Connection logic requires `status === 'running'`

## Current Status Values Used

### EC2 Instance States (from EventBridge)
- `pending` → Instance launching
- `running` → Instance running  
- `stopping` → Instance stopping
- `stopped` → Instance stopped
- `terminated` → Instance terminated

### Frontend Expected Values
- `pending`, `starting`, `stopping` → Transitional states
- `running` → Active state
- `stopped` → Inactive state

## Breaking Changes Impact

### If we change `status` → `instanceStatus`:

#### High Impact (MUST UPDATE)
1. **EventBridge Stack**: Updates the field name in DynamoDB
2. **Frontend Components**: All status display and logic
3. **Database GSI**: The `status-index` GSI name and queries
4. **Auto-shutdown Logic**: Queries by status field
5. **Cleanup Logic**: Filters by status field

#### Medium Impact (SHOULD UPDATE)  
1. **Workstation Creation**: Initial status setting
2. **API Responses**: May need to return both fields during migration

#### Low Impact (OPTIONAL)
1. **Storage Stack**: Uses separate table, different context

## Migration Strategy Required

### Phase 1: Add `instanceStatus` field
1. Update EventBridge to write to both `status` and `instanceStatus`
2. Update creation stack to set both fields
3. Database migration to copy existing `status` → `instanceStatus`

### Phase 2: Update consumers
1. Update frontend to read `instanceStatus` for EC2 state
2. Update auto-shutdown to use `instanceStatus`  
3. Update cleanup logic to use `instanceStatus`
4. Add new GSI for `instanceStatus`

### Phase 3: Implement new `status` workflow
1. Add workflow status tracking to creation/start processes
2. Update frontend to use new `status` for workflow state
3. Update connection logic to check both fields

### Phase 4: Cleanup
1. Remove old `status` GSI
2. Remove dual-write logic from EventBridge
3. Remove old `status` field references

## Recommendation

This is a **significant breaking change** that requires careful migration planning. The `status` field is deeply integrated into both backend logic and frontend UI.

**Suggested approach**: Implement the change incrementally with dual-field support during migration to avoid downtime.
