#!/usr/bin/env bash
# Run on a trusted Linux workstation/server with Bash + OpenSSL, never in the app.
set -euo pipefail
umask 077
# Git Bash must not translate OpenSSL's /CN=... subjects into Windows paths.
export MSYS_NO_PATHCONV=1

cert_dir="${CERT_DIR:-secrets}"
leaf_days="${CERT_DAYS:-365}"
ca_days="${CA_DAYS:-3650}"
app_name="${APP_TLS_NAME:-fleet-server}"
proxy_name="${PROXY_CLIENT_NAME:-fleet-proxy}"

fail() { printf '%s\n' "$*" >&2; exit 1; }
safe_name() { [[ "$1" =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$ ]] || fail "Invalid certificate name: $1"; }
safe_dns() { [[ "$1" =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]{0,127}$ ]] || fail "Invalid DNS SAN name: $1"; }
safe_credential() { [[ "$1" =~ ^[a-zA-Z][a-zA-Z0-9_-]{0,63}$ ]] || fail "Credential ID must match the configuration schema: $1"; }
[[ "$leaf_days" =~ ^[0-9]+$ && "$ca_days" =~ ^[0-9]+$ ]] || fail 'Certificate lifetimes must be positive integers.'
(( leaf_days > 0 && ca_days > 0 )) || fail 'Certificate lifetimes must be positive integers.'
safe_dns "$app_name"
safe_name "$proxy_name"
command -v openssl >/dev/null || fail 'OpenSSL is required.'
mkdir -p "$cert_dir"
scratch="$(mktemp -d "$cert_dir/.issue.XXXXXXXX")"
trap 'rm -rf -- "$scratch"' EXIT

make_ca() {
  local name="$1"
  [[ ! -e "$cert_dir/ca-private/$name.key" && ! -e "$cert_dir/ca-public/$name.pem" ]] || fail "CA $name already exists; use a new CERT_DIR for a new trust root."
  mkdir -p "$cert_dir/ca-private" "$cert_dir/ca-public"
  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out "$cert_dir/ca-private/$name.key" 2>/dev/null
  openssl req -new -x509 -sha256 -days "$ca_days" -key "$cert_dir/ca-private/$name.key" \
    -subj "/CN=Docker Fleet $name" -addext 'basicConstraints=critical,CA:TRUE' \
    -addext 'keyUsage=critical,keyCertSign,cRLSign' -out "$cert_dir/ca-public/$name.pem"
  chmod 600 "$cert_dir/ca-private/$name.key"
  chmod 644 "$cert_dir/ca-public/$name.pem"
  chmod 755 "$cert_dir/ca-public"
}

issue() {
  local ca_name="$1" cn="$2" purpose="$3" dns_name="$4" destination="$5" stem="$6" replace="$7"
  safe_name "$cn"
  [[ -f "$cert_dir/ca-private/$ca_name.key" && -f "$cert_dir/ca-public/$ca_name.pem" ]] || fail "Missing $ca_name CA; run init first."
  if [[ "$replace" != yes && ( -e "$destination/$stem.pem" || -e "$destination/$stem.key" ) ]]; then
    fail "Certificate already exists at $destination/$stem; use renew-agent or renew-proxy explicitly."
  fi
  mkdir -p "$destination"
  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$scratch/leaf.key" 2>/dev/null
  openssl req -new -sha256 -key "$scratch/leaf.key" -subj "/CN=$cn" -out "$scratch/leaf.csr"
  {
    printf '%s\n' 'basicConstraints=critical,CA:FALSE' 'keyUsage=critical,digitalSignature,keyEncipherment' "extendedKeyUsage=$purpose"
    if [[ -n "$dns_name" ]]; then
      safe_dns "$dns_name"
      printf 'subjectAltName=DNS:%s\n' "$dns_name"
    fi
  } > "$scratch/leaf.ext"
  openssl x509 -req -sha256 -days "$leaf_days" -in "$scratch/leaf.csr" \
    -CA "$cert_dir/ca-public/$ca_name.pem" -CAkey "$cert_dir/ca-private/$ca_name.key" \
    -set_serial "0x$(openssl rand -hex 16)" -extfile "$scratch/leaf.ext" -out "$scratch/leaf.pem" 2>/dev/null
  openssl verify -CAfile "$cert_dir/ca-public/$ca_name.pem" "$scratch/leaf.pem" >/dev/null
  chmod 600 "$scratch/leaf.key"
  chmod 644 "$scratch/leaf.pem"
  mv -- "$scratch/leaf.key" "$destination/$stem.key"
  mv -- "$scratch/leaf.pem" "$destination/$stem.pem"
}

agent() {
  local credential_id="$1" dns_name="$2" replace="$3"
  safe_credential "$credential_id"
  safe_dns "$dns_name"
  issue agent-ca "$dns_name" serverAuth "$dns_name" "$cert_dir/agents/$credential_id" server "$replace"
  issue agent-ca "fleet-backend-$credential_id" clientAuth '' "$cert_dir/clients/$credential_id" client "$replace"
  printf 'Issued agent %s with backend client CN fleet-backend-%s.\n' "$credential_id" "$credential_id"
}

case "${1:-}" in
  init)
    make_ca proxy-ca
    make_ca agent-ca
    issue proxy-ca "$app_name" serverAuth "$app_name" "$cert_dir/backend" server no
    issue proxy-ca "$proxy_name" clientAuth '' "$cert_dir/proxy" client no
    agent local-agent "${LOCAL_AGENT_TLS_NAME:-local-agent}" no
    [[ ! -e "$cert_dir/csrf-secret" ]] || fail 'CSRF secret already exists.'
    openssl rand -hex 32 > "$cert_dir/csrf-secret"
    chmod 600 "$cert_dir/csrf-secret"
    printf 'Initialized certificates in %s. Keep ca-private offline; adjust file ownership before starting containers.\n' "$cert_dir"
    ;;
  agent|renew-agent)
    [[ $# -eq 3 ]] || fail 'Usage: certificates.sh agent|renew-agent CREDENTIAL_ID DNS_SAN_NAME'
    replace=no
    [[ "$1" != renew-agent ]] || replace=yes
    agent "$2" "$3" "$replace"
    ;;
  renew-proxy)
    [[ $# -eq 1 ]] || fail 'Usage: certificates.sh renew-proxy'
    issue proxy-ca "$app_name" serverAuth "$app_name" "$cert_dir/backend" server yes
    issue proxy-ca "$proxy_name" clientAuth '' "$cert_dir/proxy" client yes
    printf 'Renewed application/proxy certificates. Restart the app and reload the proxy.\n'
    ;;
  *) fail 'Usage: certificates.sh init | agent CREDENTIAL_ID DNS_SAN_NAME | renew-agent CREDENTIAL_ID DNS_SAN_NAME | renew-proxy' ;;
esac
