# Add a second Docker host

The additional Docker host runs only an agent. The central app reaches it over your private network. Host display names and DNS addresses are installation choices, not code defaults.

1. Choose a unique host ID, a credential name and the agent's actual internal DNS name. The examples below use the ID/credential name `host-2`; replace `agent-2.example.invalid` with your DNS name. On the trusted certificate machine with the offline agent CA:

   ```sh
   bash scripts/certificates.sh agent host-2 agent-2.example.invalid
   ```

   This issues `secrets/agents/host-2/server.pem`, `server.key` and a dedicated `secrets/clients/host-2/client.pem`, `client.key`. The authorized backend client certificate CN is `fleet-backend-host-2`.

2. Transfer only the server key/certificate and public agent CA to the new host through an authenticated secure channel. In the project directory on that host, create `secrets/remote-agent/` containing `server.pem`, `server.key` and `agent-ca.pem`. Do not copy CA private keys or any backend client private key there. Install the project source for a local build, or transfer your own built image with `docker save`/`docker load`. No published registry image is assumed.
3. On the remote Linux host:

   ```sh
   sudo chown -R 10001:10001 secrets/remote-agent
   sudo chmod 700 secrets/remote-agent
   sudo chmod 600 secrets/remote-agent/server.key
   ```

   Create that host's `.env` with the actual values:

   ```dotenv
   FLEET_IMAGE=docker-fleet:local
   DOCKER_GID=<result-of-stat--c-%g-on-the-docker-socket>
   AGENT_HOST_ID=host-2
   AGENT_BIND_ADDRESS=<actual-private-interface-address>
   AGENT_PUBLISHED_PORT=9443
   AGENT_TLS_NAME=<actual-agent-dns-name-in-certificate>
   AGENT_ALLOWED_CLIENT_NAMES=fleet-backend-host-2
   ```

   Angle-bracket values are instructions, not runnable values. IPv6 publication requires the bracketed address syntax accepted by your Compose version. The bind address must exist on the host.

4. Permit the agent TCP port only from the central application's actual source address/network. Use your platform's Docker-aware firewall and verify the effective rules from an unauthorized machine. Publishing on a private interface alone is not a source allowlist. Docker-published traffic can bypass ordinary UFW rules; follow [Docker's firewall documentation](https://docs.docker.com/engine/network/packet-filtering-firewalls/). Do not disable Docker firewall management to work around this.
5. When ready for the separate installation:

   ```sh
   docker compose -f compose.agent.yml config
   docker compose -f compose.agent.yml build
   docker compose -f compose.agent.yml up -d
   docker compose -f compose.agent.yml ps
   ```

6. On the central host, install the backend's new client pair under `secrets/clients/host-2/`, owned by `10001:10001`, directories `0700`, key `0600`. Stop the central app before editing its authoritative configuration. Add this credential entry:

   ```yaml
   credentials:
     # Keep the existing local-agent entry as well.
     host-2:
       caFile: /secrets/ca-public/agent-ca.pem
       certFile: /secrets/clients/host-2/client.pem
       keyFile: /secrets/clients/host-2/client.key
       serverName: agent-2.example.invalid
   ```

   Replace the SAN name with the actual issued name. This catalog change requires app restart. An agent signed by a different CA uses its own public CA file and reference.

7. Start the app, open Hosts / Settings, edit the disabled `host-2` example (or add a new row), select credential `host-2`, set the actual HTTPS agent URL and enable it. Its `id` must exactly match `AGENT_HOST_ID`. Save the host, then use **Test** on its row. The test checks the saved endpoint and does not modify the configuration.
8. Verify **All hosts** shows both hosts; select each host separately and check its engine version, resources and last successful refresh. Create two disposable same-named containers during acceptance and verify an action on one changes only that host's container. Disconnect only the remote agent during a controlled check; the local host should stay responsive while the remote cache is labeled stale.

If the proxy runs on another machine, it must reach the app through an explicitly configured private connection with mTLS and a source firewall allowlist. The default central template publishes no app port; adapt only the project Compose/network configuration to match your proxy placement. Never expose an unauthenticated development listener.
