# Reverse proxy and Authentik

Production uses three checks in the central app: a verified proxy client certificate with an allowed CN, valid configured identity headers and an exact allowed username. Missing headers fail closed even when a proxy authentication check accidentally returns a successful response. Keep Authentik and the proxy patched; the [Authentik forward-auth advisory](https://docs.goauthentik.io/security/cves/CVE-2026-25748/) describes why success without identity is insufficient.

Use Authentik's **Forward auth (single application)** provider with External host set to the actual `baseUrl`, attach it to the chosen outpost and bind your permitted users/groups through your own policies. Docker Fleet's `auth.allowedUsers` is an additional server-side restriction. All allowed users have the same administrative capability in this version. See the [official Authentik provider guide](https://docs.goauthentik.io/add-secure-apps/providers/proxy/) for the provider workflow.

## Caddy example

This is a template for an existing Caddy installation supporting `tls_trust_pool`. It does not install or alter your proxy. Replace every environment value with the actual installation data. Caddy must share the configured external Docker network with the app. Only Caddy holds the proxy client private key; a browser must never receive that key or certificate pair.

Provision these environment values in the proxy's own configuration:

```dotenv
FLEET_DOMAIN=<actual-application-domain>
FLEET_ALLOWED_CIDRS=<actual-LAN-CIDR> <actual-VPN-CIDR>
AUTHENTIK_OUTPOST=https://<actual-outpost-DNS-name>:9443
AUTHENTIK_TLS_NAME=<actual-outpost-certificate-DNS-name>
FLEET_UPSTREAM=https://app:8443
FLEET_TLS_NAME=fleet-server
```

`FLEET_ALLOWED_CIDRS` is an explicit list of your allowed client networks, not all private networks. This matcher uses the immediate peer address; when another proxy sits in front, configure Caddy's trusted-proxy handling deliberately and use a validated client-address matcher. Do not blindly trust browser-supplied forwarded addresses.

Mount the public proxy CA and the issued proxy client pair into Caddy as `/etc/caddy/fleet/proxy-ca.pem`, `client.pem`, `client.key`. For the HTTPS outpost connection, mount the CA that actually issued the outpost's TLS certificate at `/etc/caddy/fleet/authentik-ca.pem`; configure that TLS endpoint separately if your current outpost has no appropriate certificate. Do not disable TLS verification.

```caddyfile
{$FLEET_DOMAIN} {
    route {
        @outside not remote_ip {$FLEET_ALLOWED_CIDRS}
        respond @outside "Access denied" 403

        # Strip every client-supplied identity family before authentication.
        request_header -X-Fleet-*
        request_header -X-Authentik-*
        request_header -X-Forwarded-*
        request_header -X-Original-URI
        request_header -X-Original-URL

        reverse_proxy /outpost.goauthentik.io/* {$AUTHENTIK_OUTPOST} {
            transport http {
                tls
                tls_server_name {$AUTHENTIK_TLS_NAME}
                tls_trust_pool file /etc/caddy/fleet/authentik-ca.pem
            }
        }

        forward_auth {$AUTHENTIK_OUTPOST} {
            uri /outpost.goauthentik.io/auth/caddy
            copy_headers X-Authentik-Username>X-Fleet-User X-Authentik-Uid>X-Fleet-Subject
            transport http {
                tls
                tls_server_name {$AUTHENTIK_TLS_NAME}
                tls_trust_pool file /etc/caddy/fleet/authentik-ca.pem
            }
        }

        reverse_proxy {$FLEET_UPSTREAM} {
            transport http {
                tls
                tls_server_name {$FLEET_TLS_NAME}
                tls_trust_pool file /etc/caddy/fleet/proxy-ca.pem
                tls_client_auth /etc/caddy/fleet/client.pem /etc/caddy/fleet/client.key
            }
        }
    }
}
```

The `route` keeps header removal before the authentication subrequest. Authentik's response supplies only Username and Uid, renamed to the app's configured `x-fleet-user` and `x-fleet-subject`. If you choose different identity names, strip those names before auth and copy only their trusted replacements. Header casing in the `copy_headers` source names follows [Authentik's Caddy example](https://docs.goauthentik.io/add-secure-apps/providers/proxy/server_caddy/); renamed copy syntax is described in [Caddy's forward_auth reference](https://caddyserver.com/docs/caddyfile/directives/forward_auth). Upstream TLS trust and client certificates follow [Caddy's reverse_proxy reference](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy).

The template passed `caddy validate` in an isolated container running Caddy 2.11.4 with generated test certificates and network access disabled. This checks syntax and local certificate-file loading; it does not test your Authentik outpost or infrastructure. Adapt and validate it again with `caddy validate --config <actual-Caddyfile>` before separately applying it. Use valid DNS/certificates for the browser's HTTPS endpoint as usual. Hosting at a URL subpath is not supported; use a dedicated origin.

## Request protection

API reads reject cross-origin browser requests. Start/stop/restart, configuration writes, resource refresh and connection tests require the exact configured `Origin` plus a short-lived HMAC CSRF token bound to the authenticated subject and username. Configuration reload occurs through the authenticated same-origin `GET /api/config`. The browser gets its token from the authenticated app session; no agent credential is included. Tokens expire after 30 minutes; the UI normally refreshes its session every 10 minutes, and a stale tab may need reloading.

Live log reads use the same authenticated application origin, proxy certificate and identity checks. Do not exempt log or API routes from forward authentication. Logs stream as `application/x-ndjson` with no predetermined content length; verify that your proxy forwards chunks promptly and cancels upstream reads when a browser leaves. Caddy's default handling flushes responses with unknown length. The application enforces its own finite stream limit.

Only a minimal `/healthz` liveness response bypasses identity checks. It contains no Docker resources or configuration. Production TLS stays enabled for it. It proves the process answers, not that an agent, user or Authentik session is valid.

## Installation verification

- Through the public/private application origin, no session must redirect to authentication or return a denial; a disallowed username must receive `403`.
- Send forged `X-Fleet-User`/`X-Fleet-Subject` values without an Authentik session. They must be stripped and must not grant access.
- From a machine without the proxy client key, request a protected backend endpoint directly with forged identity headers. It must fail regardless of the strings.
- From an allowed session, send a mutation with the wrong/missing `Origin` or CSRF token. It must fail. Then check a valid action on a disposable container and inspect its audit record.
- Open live logs as an allowed user, then verify the stream closes on exit and that a new unauthenticated request cannot open a stream.

The Compose defaults avoid a directly published app port. Network access controls remain useful defense in depth but never replace mTLS, header sanitation or server authorization.
