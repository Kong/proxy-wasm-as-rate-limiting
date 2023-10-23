export * from "@kong/proxy-wasm-sdk/assembly/proxy";

import {
  RootContext,
  Context,
  registerRootContext,
  log,
  LogLevelValues,
  FilterHeadersStatusValues,
  stream_context,
  get_current_time_nanoseconds,
  get_property,
  get_shared_data,
  GetSharedData,
  set_shared_data,
  WasmResultValues,
  send_local_response,
  GrpcStatusValues
} from "@kong/proxy-wasm-sdk/assembly";

import { JSON } from "json-as/assembly";

@json
class Config {
  second: i32 = 0;
  minute: i32 = 0;
  hour: i32 = 0;
  day: i32 = 0;
  month: i32 = 0;
  year: i32 = 0;

  limit_by: String | null;
  header_name: String | null;
  path: String | null;
  policy: String | null;

  fault_tolerant: bool = false;
  hide_client_headers: bool = false;
  error_code: u32 = 401;
  error_message: String | null;

}

class Usage {
  limit: i32;
  usage: i32;
  remaining: i32;
  cas: u32;

  constructor(limit: i32, usage: i32, remaining: i32, cas: u32) {
    this.limit = limit;
    this.remaining = remaining;
    this.usage = usage;
    this.cas = cas;
  }
}

class UsageResult {
  value: i32;
  cas: u32;
  result: WasmResultValues;
}

class Usages {
  counters: Map<String, Usage> = new Map<String, Usage>();
  stop: String | null;
  err: String | null;
}

type TimestampMap = Map<String, i64>;
type UsageMap = Map<String, Usage>;

function getTimestamps(now: Date): TimestampMap {
    let ts: TimestampMap = new Map<String, i64>();

    ts["now"] = now.getTime();

    now.setUTCMilliseconds(0);
    ts["second"] = now.getTime();

    now.setUTCSeconds(0);
    ts["minute"] = now.getTime();

    now.setUTCMinutes(0);
    ts["hour"] = now.getTime();

    now.setUTCHours(0);
    ts["day"] = now.getTime();

    now.setUTCDate(0);
    ts["month"] = now.getTime();

    now.setUTCMonth(0);
    ts["year"] = now.getTime();

    return ts
}

let EXPIRATION: Map<String, i32> = new Map<String, i32>();
let X_RATE_LIMIT_LIMIT: Map<String, String> = new Map<String, String>();
let X_RATE_LIMIT_REMAINING: Map<String, String> = new Map<String, String>();
const PERIODS = ["Second", "Minute", "Hour", "Day", "Month", "Year"];

for (let i = 1; i < PERIODS.length; i++) {
  let period = PERIODS[i];

  EXPIRATION[period.toLowerCase()] = Math.pow(60, i) as i32;
  X_RATE_LIMIT_LIMIT[period.toLowerCase()] = `X-RateLimit-Limit-${period}`
  X_RATE_LIMIT_REMAINING[period.toLowerCase()] = `X-RateLimit-Remaining-${period}`;
}

class RateLimitingRoot extends RootContext {
  config: Config | null;

  createContext(context_id: u32): Context {
    return new RateLimitingHTTP(context_id, this);
  }

  fillConfigStringDefaults(): void {
    let config = this.config as Config;
  }

  onConfigure(configuration_size: u32): bool {
    let ok = super.onConfigure(configuration_size);
    if (!ok) {
        return false;
    }

    let config = JSON.parse<Config>(this.configuration_);
    // while as-json doesn't support default values, they're set here.
    if (config.limit_by === null) {
      config.limit_by = "ip";
    }

    if (config.policy === null) {
      config.policy = "local";
    }

    if (config.error_message === null) {
      config.error_message = "AssemblyScript informs: API rate limit exceeded!";
    }

    if (config.error_code === 0) {
      config.error_code = 429;
    }

    this.config = config;

    return true;
  }
}

class RateLimitingHTTP extends Context {
  config: Config;
  limits: Map<String, i32>;
  headers: Map<String, String>;

  constructor(context_id: u32, root_context: RateLimitingRoot) {
    super(context_id, root_context);

    this.config = root_context.config as Config;

    this.headers = new Map<String, String>();
    this.limits = new Map<String, i32>();
    this.limits["second"] = this.config.second;
    this.limits["minute"] = this.config.minute;
    this.limits["hour"] = this.config.hour;
    this.limits["day"] = this.config.day;
    this.limits["month"] = this.config.month;
    this.limits["year"] = this.config.year;
  }

  onRequestHeaders(a: u32, end_of_stream: bool): FilterHeadersStatusValues {
    let now: Date = new Date(get_current_time_nanoseconds() / 1000000);
    let ts = getTimestamps(now);
    let id = this.getIdentifier();
    let usages = this.getUsages(id, ts);

    let action = this.processUsage(usages.counters, ts, usages.stop);
    if (action != FilterHeadersStatusValues.Continue) {
        return action;
    }

    this.increment(id, usages.counters, ts);

    return FilterHeadersStatusValues.Continue;
  }

  onResponseHeaders(a: u32, end_of_stream: bool): FilterHeadersStatusValues {
    if(!end_of_stream) {
      return FilterHeadersStatusValues.Continue;
    }

    if(this.headers) {
      let headers = this.headers as Map<String, String>;

      for(let i = 0; i < headers.size; i++) {
        let key = headers.keys()[i];
        stream_context.headers.response.replace(key, headers[key]);
      }
    }

    return FilterHeadersStatusValues.Continue;
  }

  getUsage(id: String, period: String, ts: TimestampMap): UsageResult {
    let cache_key = this.getLocalKey(id, period, ts[period]);
    let ret = new UsageResult();
    let value = get_shared_data(cache_key);
    ret.result = value.result;

    if (value.result != WasmResultValues.Ok && value.result != WasmResultValues.NotFound) {
      if (this.config.fault_tolerant)
        log(LogLevelValues.error, `Failed to get usage, WasmResultValues: ${value.result}`);
      else
        throw new Error(`Failed to get usage, WasmResultValues: ${value.result}`)
    }

    if (value.value != null) {
      let usage = Int32Array.wrap(value.value as ArrayBuffer, 0, 1)[0];

      if (value.result == WasmResultValues.Ok) {
        ret.value = usage;
        ret.cas = value.cas;
      }
    }

    return ret;
  }

  getUsages(id: String, ts: TimestampMap): Usages {
    let usages: Usages = new Usages();
    let counters = new Map<String, Usage>();

    for (let i = 0; i < this.limits.size; i++) {
      let period = this.limits.keys()[i];
      let limit = this.limits[period];

      if (limit > 0) {
        let request = this.getUsage(id, period, ts);
        let cur_usage = request.value;
        let remaining = limit - cur_usage;

        counters.set(period, new Usage(limit, cur_usage, remaining, request.cas));

        if (remaining <= 0) {
            usages.stop = period;
        }
      }
    }

    usages.counters = counters;

    return usages
  }

  processUsage(counters: UsageMap, ts: TimestampMap, stop: String | null): FilterHeadersStatusValues {
    let now = ts["now"];
    let reset: i32 = 0;
    let limit: i32 = 0;
    let window: i32 = 0;
    let remaining: i32 = 0;
    let headers = new Map<String, String>();

    for (let i = 0; i < counters.size; i++) {
      let period = counters.keys()[i];
      let usage = counters[period];
      let cur_limit = usage.limit;
      let cur_window = EXPIRATION[period];
      let cur_remaining = Math.max(0, usage.remaining) as i32;

      if (limit == 0 || cur_remaining < remaining || (cur_remaining == remaining && cur_window > window)) {
          limit = cur_limit;
          window = cur_window;
          remaining = cur_remaining;
          reset = Math.max(1, window - (now - ts[period]) / 1000 as i32) as i32;
      }

      headers.set(X_RATE_LIMIT_LIMIT[period], `${cur_limit}`);
      headers.set(X_RATE_LIMIT_REMAINING[period], `${Math.max(0, cur_remaining - 1) as i32}`);
    }

    if (!this.config.hide_client_headers) {
        headers.set("X-RateLimit-Limit", `${limit}`);
        headers.set("X-RateLimit-Remaining", `${Math.max(0, remaining - 1) as i32}`);
        headers.set("X-RateLimit-Reset", `${reset}`);
    }

    this.headers = headers;

    if (stop) {
      let errorCode: u32 = this.config.error_code;
      let response = String.UTF8.encode(this.config.error_message as String);
      let grpcStatus = GrpcStatusValues.PermissionDenied;

      headers.set("X-RateLimit-Retry-After", reset.toString());
      send_local_response(errorCode, "Not authorized", response, [], grpcStatus);

      return FilterHeadersStatusValues.StopIteration;

    } else {
      return FilterHeadersStatusValues.Continue;
    }

    return FilterHeadersStatusValues.Continue
  }

  increment(id: String, counters: UsageMap, ts: TimestampMap): void {
    for (let i = 0; i < counters.size; i++) {
      let period = counters.keys()[i];
      let usage = counters[period];
      let cache_key = this.getLocalKey(id, period, ts[period]);
      let value = usage.usage;
      let cas = usage.cas;

      let saved = false;
      for (let j = 0; j < 10; j++) {
        let buf = new Int32Array(1);
        buf[0] = value + 1;
        let result = set_shared_data(cache_key, buf.buffer, cas);

        if (result == WasmResultValues.Ok) {
          saved = true;
          break;
        }

        if (result == WasmResultValues.CasMismatch) {
          let result = this.getUsage(id, period, ts);
          if (result.result == WasmResultValues.Ok) {
            value = result.value;
            cas = result.cas;
          }
        }
      }

      if (!saved) {
        log(LogLevelValues.error, `Could not increment counter for period: ${period}`);
      }
    }
  }

  getIdentifier(): String {
    let headers = stream_context.headers.request;
    let limit_by = this.config.limit_by as String;

    if(limit_by == "header") {
      return headers.get(this.config.header_name as String);
    } else if (limit_by == "path") {
      return headers.get(":path");
    }

    return this.getProperty("ngx.remote_addr");
  }

  getProperty(name: String): String {
    let value = get_property(name);

    if (value.byteLength == 0) {
      return "";
    }

    return String.UTF8.decode(value);
  }

  getLocalKey(id: String, period: String, date: i64): String {
    let route_id = this.getProperty("kong.route_id");
    let service_id = this.getProperty("kong.service_id");

    return `kong_wasm_rate_limiting_counters/ratelimit:${route_id}:${service_id}:${id}:${date.toString()}:${period}`;
  }
}

registerRootContext((context_id: u32) => {
    return new RateLimitingRoot(context_id);
}, "RateLimitingFilter");
