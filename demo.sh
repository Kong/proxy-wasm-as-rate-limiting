#!/usr/bin/env bash
set -x

DEMO_NETWORK_NAME="${DEMO_NETWORK_NAME:-rate-limting-demo}"
DEMO_UPSTREAM_IMAGE="${DEMO_UPSTREAM_IMAGE:-kennethreitz/httpbin}"
DEMO_UPSTREAM_CONTAINER="${DEMO_UPSTREAM_CONTAINER:-rate-limiting-demo-httpbin}"
DEMO_KONG_CONTAINER="${DEMO_KONG_CONTAINER:-rate-limiting-demo-kong}"
DEMO_KONG_IMAGE="${DEMO_KONG_IMAGE:-kong}"
DEMO_DOCKER_NETWORK="${DEMO_DOCKER_NETWORK:-rate-limiting-demo}"
SCRIPT_DIR=$(dirname $(realpath $0))

################################################################################

docker stop "$DEMO_KONG_CONTAINER" "$DEMO_UPSTREAM_CONTAINER" > /dev/null 2>&1
docker network rm "$DEMO_NETWORK_NAME" > /dev/null 2>&1

if [[ "$1" == "stop" ]]; then
    exit 0
fi

# make sure kong service config points to $DEMO_UPSTREAM_CONTAINER
sed -i 's@http://[a-zA-Z0-9\-]\+/@'"http://$DEMO_UPSTREAM_CONTAINER/"'@g' "$SCRIPT_DIR/config/demo.yml"

docker network create "$DEMO_NETWORK_NAME"
docker run -d \
           --rm \
           --name "$DEMO_UPSTREAM_CONTAINER" \
           --network "$DEMO_NETWORK_NAME" \
           "$DEMO_UPSTREAM_IMAGE"

docker run -d \
           --rm \
           --name "$DEMO_KONG_CONTAINER" \
           --network "$DEMO_NETWORK_NAME" \
           -v "$SCRIPT_DIR/config:/kong/config/" \
           -v "$SCRIPT_DIR/build:/wasm" \
           -e "KONG_DATABASE=off" \
           -e "KONG_WASM=on" \
           -e "KONG_DECLARATIVE_CONFIG=/kong/config/demo.yml" \
           -e "KONG_NGINX_WASM_SHM_KONG_WASM_RATE_LIMITING_COUNTERS=12m" \
           -e "KONG_WASM_FILTERS_PATH=/wasm" \
           -p 8000:8000 \
           -p 8443:8443 \
           -p 8001:8001 \
           -p 8444:8444 \
            "$DEMO_KONG_IMAGE"
