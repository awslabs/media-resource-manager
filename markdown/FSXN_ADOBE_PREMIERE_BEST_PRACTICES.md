# FSxN with Adobe Premiere Pro - Best Practices

## Executive Summary

This document presents testing results for Amazon FSx for NetApp ONTAP (FSxN) with Adobe Premiere Pro, focusing on ProRes 422 HQ 4K 29.97 fps codec performance.

### Key Findings

- **2GB/s FSxN**: Suitable only for 1-5 active concurrent editors with ProRes 422 HQ 4K
- **6HA pairs 6GB/s (36GB/s)**: Achieved 120+ concurrent streams
- **6HA pairs 3GB/s (18GB/s) with FSxN 9.14.1**: Also achieved 120 streams (significant improvement from 76 streams on 9.13.1)
- **Tuning is critical**: Untuned volumes perform at ~50% of tuned capacity

## FSxN Configuration Recommendations

### Volume Configuration

1. **Use FlexGroup volumes** - Aggregates multiple drives for high sequential I/O
   - Default: 8 constituents per HA pair
   - Stripes data across drives for combined bandwidth

2. **Disable Min Readahead**:
   ```
   set -privilege advanced
   volume modify -min-readahead False
   ```

3. **Enable Multichannel** (should be enabled by default):
   ```
   set -privilege advanced
   vserver cifs options modify -vserver <vserver_name> -is-multichannel-enabled true
   ```

4. **Enable Large MTU**:
   ```
   set -privilege advanced
   vserver cifs options modify -vserver <vserver_name> -is-large-mtu-enabled true
   ```

5. **Enable Jumbo Frames** on clients (OS-dependent)

## Performance Results

| Configuration | Streams Before Frame Drop |
|--------------|---------------------------|
| FSxN 2GB/s Base | ~10 |
| FSxN 2GB/s + Tuned | ~20 |
| FSxN 2 Node 2HA 6GB/s (12GB/s) | ~40 |
| FSxN 6 Node 6HA 3GB/s (18GB/s) | 76 |
| FSxN 6 Node 6HA 3GB/s (18GB/s) 9.14.1 | 120 |
| FSxN 6 Node 6HA 6GB/s (36GB/s) | 120+ |

## Sizing Considerations

### Codec Impact
- High-bitrate codecs (ProRes) require more throughput than H264/XDCAM50
- Plan storage based on codec requirements

### User Scaling
- Consider concurrent users accessing storage
- Higher user counts need higher throughput and IOPS

### Layer Considerations
- Adobe renders top-down, requesting only visible layers
- Effects on lower layers increase storage I/O (up to 4x)
- Multiple active layers significantly increase throughput demands

### Latency Tolerance
- Adobe's readahead caching can spike throughput demands
- Cache fill time: few seconds (low bitrate) to 30+ seconds (high bitrate)
- Storage must handle peak throughput during cache fill

## Adobe Premiere Pro Setup

### Scratch Disks
- Safe to place on FSxN shared storage
- Configure in: File > Project Settings > Scratch Disks

### Media Cache (CRITICAL)
- **Strongly recommended**: Place on dedicated EBS volume attached to EC2
- Adobe does not support Media Cache on shared storage
- If issues occur, this is the first area to investigate

### Playback Settings
- Use lower resolution (1/16, 1/8) to maximize streams from storage
- Individual editors can use higher settings (1/4, 1/2, full)
- Playback resolution doesn't affect storage utilization (full asset requested)

## Protocol Support

FSxN supports both NFS and SMB protocols, making it ideal for:
- Mixed Windows/Linux environments
- Workflows requiring protocol flexibility
