# DCV Connection Gateway: browser path and client allowlist

From v1.5.0 the DCV Connection Gateway accepts session-token connections only.
It no longer serves the DCV web client, so an HTTP request without a DCV session
token gets an empty `404`. Browser sessions load the viewer from the MRM console
and connect to the gateway through the path below.

## Browser path (`DcvBrowserPath`)

| Value | Browser connects to | Certificate the browser sees |
|---|---|---|
| `cloudfront` (default) | `wss://<id>.cloudfront.net`, one CloudFront distribution per gateway Region | `*.cloudfront.net`, publicly trusted. No domain needed. |
| `direct` | `wss://<gateway>:8443` on the gateway's Network Load Balancer | The gateway's certificate. Self-signed unless you set `DcvDomainName` and a certificate. |

Native DCV clients use the gateway's Network Load Balancer in both modes (QUIC
on UDP 8444, and TCP 8443).

The setting applies to the primary Region and to every regional hub. Hubs pick
up a change on their next **Update** on the Regions page.

### What `cloudfront` creates in each gateway Region

```
Browser --TLS--> CloudFront distribution
                   --> VPC origin --> internal Application Load Balancer (HTTP 80, or HTTPS 443 with DcvHostedZoneId)
                                        --TLS--> Connection Gateway TCP 8443
```

- An internal Application Load Balancer in the private subnets. Its security
  group accepts only CloudFront's origin-facing prefix list
  (`com.amazonaws.global.cloudfront.origin-facing`) and sends only to the
  gateway's web port.
- A CloudFront VPC origin for that load balancer (TLS 1.2 only), and a
  distribution with the default CloudFront certificate, caching disabled and
  the `AllViewer` origin request policy.
- A CloudFront Function that answers CORS preflight requests for the gateway's
  HTTP routes (file transfer, printing). Other requests pass through unchanged.
- The SSM parameter `/<ProductName>/DCV/BrowserGatewayUrl` in that Region, with
  the URL the browser viewer connects to. Regional hubs also return it as the
  stack output `BrowserGatewayUrl`, saved on the hub as `browserGatewayUrl`.
  In `direct` mode the value is `https://<gateway>:8443`.

The load balancer only uses subnets in Availability Zones that support CloudFront
VPC origins. The zone IDs `use1-az3`, `usw1-az2`, `apne1-az3` and `cac1-az3`
aren't supported. The deployment needs private subnets in at least two other
zones; otherwise use `direct`.

**Logging is off on the distribution and the load balancer.** The first request
of a browser session carries the DCV session token in its query string, and
CloudFront standard logs and load balancer access logs record query strings.
If you turn either on, treat the logs as sensitive.

### Encryption on each hop

| Hop | Without `DcvHostedZoneId` | With `DcvHostedZoneId` |
|---|---|---|
| Browser to CloudFront | TLS, trusted certificate | TLS, trusted certificate |
| CloudFront to the load balancer | HTTP over the VPC origin's private connection inside AWS | TLS, DNS-validated ACM certificate |
| Load balancer to the gateway | TLS; the gateway certificate isn't validated | same |
| Gateway to the workstation | TLS (unchanged) | same |

The DCV session token is still checked end to end by the workstation's DCV
server. If you need TLS on every hop, set `DcvHostedZoneId` to a Route 53
public hosted zone in the account: MRM creates the record
`dcv-gateway-origin.<region>.<zone>` and a DNS-validated certificate for it in
each gateway Region. Or use `direct` with your own gateway certificate.

### Cost

Each gateway Region adds an Application Load Balancer (about USD 16 per month
plus LCU charges in us-east-1). VPC origins have no extra charge. CloudFront data
transfer replaces data transfer out from the Network Load Balancer, at a similar
rate per GB.

### Removing it

For a VPC origin, CloudFront creates a security group named
`CloudFront-VPCOrigins-Service-SG` and one network interface per load balancer
subnet in the VPC. CloudFront owns them, not the MRM stacks, and removes them
itself shortly after the VPC origin is deleted. No manual cleanup is needed.

- **Regional hub delete:** the hub stack owns its VPC. CloudFront removes the
  interfaces and the security group 1.5 to 2 minutes after CloudFormation
  reports the VPC origin deleted, and a subnet or VPC that still has them
  can't be deleted. So after deleting the VPC origin, the stack waits until
  both are gone (up to 10 minutes) before it deletes the subnets and the VPC. In a test, deleting the distribution, the
  VPC origin and the load balancer took about 12 minutes.
- **Uninstalling MRM:** the VPC is deleted by a later stack than the browser
  path, so the interfaces are gone by then.
- **Left by design:** the first VPC origin in an account creates the
  account-wide service-linked role `AWSServiceRoleForCloudFrontVPCOrigin`. It
  stays after uninstall and grants nothing on its own.

## Client allowlist (optional)

By default the gateway's public ports (TCP 8443 and UDP 8444) are open: the
gateway only accepts connections with a DCV session token. To limit which
networks can reach them:

- `DcvAllowedClientCidrs`: comma-separated IPv4 CIDR ranges, for example office
  or VPN egress ranges. Applies to the primary gateway and every regional hub.
- `DcvAllowedPrefixListIds`: up to 2 managed prefix list IDs for the primary
  gateway. Prefix lists are per Region, so a regional hub takes its own list in
  the hub's `dcvAllowedPrefixListIds` field.

Each prefix list gets a security group of its own per protocol, because a prefix
list counts as its maximum number of entries against the rules-per-security-group
quota. With two prefix lists the gateway has five security groups, the default
per-network-interface limit. Raise the rules-per-security-group quota first if a
prefix list is larger than the quota.

The allowlist doesn't apply to browser sessions in `cloudfront` mode: they
reach the gateway through CloudFront and the load balancer. A browser session
still needs a DCV session token, which only a signed-in console user can get.
`WafAllowedIps` limits who can reach the console itself.

## Checking an install

An anonymous request to the gateway or its distribution should return no page:

```bash
curl -sk -o /dev/null -w '%{http_code}\n' https://<gateway>:8443/
curl -s  -o /dev/null -w '%{http_code}\n' https://<id>.cloudfront.net/
```

Both print `404`. The WebSocket endpoint should still upgrade:

```bash
curl -s --http1.1 -o /dev/null -w '%{http_code}\n' -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' -H "Sec-WebSocket-Key: $(openssl rand -base64 16)" --max-time 10 https://<id>.cloudfront.net/ws
```

prints `101` (the gateway closes the socket after a few seconds without a
session token). Use `GET`, not `HEAD`, for health probes: the gateway answers
every `HEAD` with 404, which CloudFront reports as `Error from cloudfront`.
