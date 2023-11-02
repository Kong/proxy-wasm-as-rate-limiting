# proxy-wasm-as-rate-limiting

A prototype implementation of a rate-limiting filter written in AssemblyScript,
using the proxy-wasm API for running on WebAssembly-enabled gateways.

## What's implemented

* "local" policy only, using the SHM-based key-value store

## What's missing

* Other policies, which would require additional features from the
  underlying system, such as calling out to a Redis instance.

## Build requirements

* Node
  * [nodejs.org](https://nodejs.org)

## Building

Once the environment is set up with `npm` in your PATH,
you can build it with:

```
npm install && make
```

This will produce `as_rate_limiting_debug.wasm` and `as_rate_limiting.wasm`
files in `build/`.

## Running

Make sure Kong configuration has the parameter [wasm](https://docs.konghq.com/gateway/latest/reference/configuration/#webassembly-wasm-section)
set to `on` and the [injected nginx directive](https://docs.konghq.com/gateway/latest/reference/nginx-directives)
`nginx_wasm_shm_kong_wasm_rate_limiting_counters` set
to some reasonable value, e.g. `12m`. This [directive](https://github.com/Kong/ngx_wasm_module/blob/main/docs/DIRECTIVES.md#shm_kv)
defines a shared key/value memory zone named `kong_wasm_rate_limiting_counters`
that's used by the filter to share request counters between workers.

The above configuration can be achieved using the environment variables:
 - `KONG_WASM=on`
 - `KONG_NGINX_WASM_SHM_KONG_WASM_RATE_LIMITING_COUNTERS=12m`

The script `demo.sh` uses docker to start an upstream service and a Kong
instance configured to receive requests at `http://localhost:8000/rated` and to
allow only 3 requests per minute through the upstream service.

The docker resources created and initialized by the script can be destroyed by
invoking `./demo.sh stop`.
