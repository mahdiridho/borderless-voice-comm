#!/bin/bash
# get-thumbprint.sh

OIDC_URL="token.actions.githubusercontent.com"
HOST="$OIDC_URL"

# Get certificate
CERT=$(echo | openssl s_client -servername "$HOST" -connect "$HOST:443" 2>/dev/null | sed -ne '/-BEGIN CERTIFICATE-/,/-END CERTIFICATE-/p')

# Get thumbprint
THUMBPRINT=$(echo "$CERT" | openssl x509 -fingerprint -sha1 -noout | cut -d'=' -f2 | tr -d ':' | tr '[:upper:]' '[:lower:]')

echo "Thumbprint: $THUMBPRINT"