# QUIC/UDP Streaming Implementation Guide

## Problem
DCV clients were connecting via WebSocket/TCP instead of QUIC/UDP, resulting in higher latency.

## Solution
Use separate ports for TCP and QUIC, with the native DCV client connecting to the QUIC port (8444) for better streaming performance.

## Architecture

| Protocol | Port | Use Case |
|----------|------|----------|
| TCP/HTTPS | 8443 | Browser connections (WebSocket) |
| UDP/QUIC | 8444 | Native DCV client (better performance) |

## Implementation Status: ✅ COMPLETE

### Changes Made:

#### 1. Connection Gateway - `user-data/connection-gateway-install.sh`
- Configured QUIC to listen on port 8444
- Set `quic-port = 8444`
- Set `quic-listen-endpoints = ["0.0.0.0:8444", "[::]:8444"]`

#### 2. DCV Session Manager Lambda - `lambda/dcv-session-manager/index.py`
- Added `quicConnectionUrl` to the API response (port 8444)
- Kept `connectionUrl` for browser connections (port 8443)

#### 3. Frontend - `frontend/src/pages/WorkstationManagement.tsx` & `Dashboard.tsx`
- Native client connections now use `quicConnectionUrl` (port 8444)
- Browser connections continue using `connectionUrl` (port 8443)

## How It Works

1. User clicks "Connect" → "DCV Client"
2. Frontend requests session from `/dcv` API
3. Lambda returns both URLs:
   - `connectionUrl`: `https://gateway:8443/?authToken=...` (for browser)
   - `quicConnectionUrl`: `https://gateway:8444/?authToken=...` (for native client)
4. Frontend uses `quicConnectionUrl` for native client, converts to `dcv://gateway:8444/...`
5. DCV client connects via QUIC/UDP on port 8444

## NLB Configuration

The NLB has two listeners:
- TCP:8443 → Connection Gateway TCP:8443 (browser/WebSocket)
- UDP:8444 → Connection Gateway UDP:8444 (native client/QUIC)

## Security Groups

Both ports are open in the Connection Gateway security group:
- TCP 8443 from 0.0.0.0/0
- UDP 8444 from 0.0.0.0/0

## Verification

After deployment:
1. Connect via native DCV client
2. Check Streaming Metrics in DCV client
3. Should show "QUIC / UDP" instead of "WS / TCP"

## Note on TCP_QUIC

AWS announced TCP_QUIC protocol for NLB in November 2025, which would allow both TCP and QUIC on the same port (8443). However, as of February 2026, AWS AutoScaling doesn't support TCP_QUIC target groups yet. Once AWS adds support, we could consolidate to a single port.
