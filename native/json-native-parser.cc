// Native fd-based JSONL parser for Node.js (N-API)
// - Reads from a provided file descriptor on a background thread
// - Splits by delimiter (default "\n")
// - Parses full JSON (objects/arrays/strings/numbers/bools/null) into a native value tree
// - Converts to JS values on the main thread via napi_threadsafe_function
// - Emits batches to JS to reduce callback overhead

#include <node_api.h>

#include <atomic>
#include <cerrno>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <string>
#include <chrono>
#include <thread>
#include <utility>
#include <vector>

#if defined(_WIN32)
#  include <io.h>
#  define dup _dup
#  define close _close
#  define read _read
#else
#  include <unistd.h>
#endif

// -----------------------------
// Small helpers
// -----------------------------

static void napi_throw_last_error(napi_env env, const char* msg) {
  napi_throw_error(env, nullptr, msg);
}

static bool is_napi_function(napi_env env, napi_value v) {
  napi_valuetype t = napi_undefined;
  napi_typeof(env, v, &t);
  return t == napi_function;
}

static napi_value make_string(napi_env env, const std::string& s) {
  napi_value out;
  napi_create_string_utf8(env, s.c_str(), s.size(), &out);
  return out;
}

static napi_value make_uint32(napi_env env, uint32_t n) {
  napi_value out;
  napi_create_uint32(env, n, &out);
  return out;
}

static napi_value make_double(napi_env env, double d) {
  napi_value out;
  napi_create_double(env, d, &out);
  return out;
}

static napi_value make_bool(napi_env env, bool b) {
  napi_value out;
  napi_get_boolean(env, b, &out);
  return out;
}

// -----------------------------
// Native JSON value tree
// -----------------------------

struct JValue {
  enum class Type { Null, Bool, Number, String, Array, Object };

  Type type = Type::Null;
  bool b = false;
  double num = 0.0;
  std::string str;
  std::vector<JValue> arr;
  std::vector<std::pair<std::string, JValue>> obj;
};

// -----------------------------
// Minimal JSON parser (recursive descent)
// -----------------------------

struct ParseCtx {
  const char* p;
  const char* end;
};

static inline void skip_ws(ParseCtx& c) {
  while (c.p < c.end) {
    const unsigned char ch = static_cast<unsigned char>(*c.p);
    if (ch == ' ' || ch == '\n' || ch == '\r' || ch == '\t') {
      c.p++;
      continue;
    }
    break;
  }
}

static bool parse_literal(ParseCtx& c, const char* lit) {
  const size_t n = std::strlen(lit);
  if (static_cast<size_t>(c.end - c.p) < n) return false;
  if (std::memcmp(c.p, lit, n) != 0) return false;
  c.p += n;
  return true;
}

static bool parse_hex4(ParseCtx& c, uint32_t& out) {
  out = 0;
  for (int i = 0; i < 4; i++) {
    if (c.p >= c.end) return false;
    const char ch = *c.p++;
    uint32_t v = 0;
    if (ch >= '0' && ch <= '9') v = static_cast<uint32_t>(ch - '0');
    else if (ch >= 'a' && ch <= 'f') v = static_cast<uint32_t>(10 + (ch - 'a'));
    else if (ch >= 'A' && ch <= 'F') v = static_cast<uint32_t>(10 + (ch - 'A'));
    else return false;
    out = (out << 4) | v;
  }
  return true;
}

static void append_utf8(std::string& s, uint32_t cp) {
  if (cp <= 0x7F) {
    s.push_back(static_cast<char>(cp));
  } else if (cp <= 0x7FF) {
    s.push_back(static_cast<char>(0xC0 | ((cp >> 6) & 0x1F)));
    s.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
  } else if (cp <= 0xFFFF) {
    s.push_back(static_cast<char>(0xE0 | ((cp >> 12) & 0x0F)));
    s.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
    s.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
  } else {
    s.push_back(static_cast<char>(0xF0 | ((cp >> 18) & 0x07)));
    s.push_back(static_cast<char>(0x80 | ((cp >> 12) & 0x3F)));
    s.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
    s.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
  }
}

static bool parse_string(ParseCtx& c, std::string& out) {
  if (c.p >= c.end || *c.p != '"') return false;
  c.p++;  // consume "
  out.clear();

  while (c.p < c.end) {
    const char ch = *c.p++;
    if (ch == '"') {
      return true;
    }
    if (static_cast<unsigned char>(ch) < 0x20) {
      return false;  // control chars not allowed in JSON strings
    }
    if (ch != '\\') {
      out.push_back(ch);
      continue;
    }
    // escape sequence
    if (c.p >= c.end) return false;
    const char esc = *c.p++;
    switch (esc) {
      case '"': out.push_back('"'); break;
      case '\\': out.push_back('\\'); break;
      case '/': out.push_back('/'); break;
      case 'b': out.push_back('\b'); break;
      case 'f': out.push_back('\f'); break;
      case 'n': out.push_back('\n'); break;
      case 'r': out.push_back('\r'); break;
      case 't': out.push_back('\t'); break;
      case 'u': {
        uint32_t cp = 0;
        if (!parse_hex4(c, cp)) return false;
        // handle surrogate pairs
        if (cp >= 0xD800 && cp <= 0xDBFF) {
          // expect low surrogate
          const char* save = c.p;
          if (c.p + 2 <= c.end && c.p[0] == '\\' && c.p[1] == 'u') {
            c.p += 2;
            uint32_t cp2 = 0;
            if (!parse_hex4(c, cp2)) return false;
            if (cp2 >= 0xDC00 && cp2 <= 0xDFFF) {
              const uint32_t hi = cp - 0xD800;
              const uint32_t lo = cp2 - 0xDC00;
              const uint32_t full = 0x10000 + ((hi << 10) | lo);
              append_utf8(out, full);
              break;
            }
          }
          // invalid surrogate pair -> restore and encode replacement char
          c.p = save;
          append_utf8(out, 0xFFFD);
          break;
        }
        if (cp >= 0xDC00 && cp <= 0xDFFF) {
          // lone low surrogate
          append_utf8(out, 0xFFFD);
          break;
        }
        append_utf8(out, cp);
        break;
      }
      default:
        return false;
    }
  }
  return false;
}

static bool parse_number(ParseCtx& c, double& out) {
  const char* start = c.p;
  if (c.p < c.end && (*c.p == '-' )) c.p++;
  if (c.p >= c.end) { c.p = start; return false; }

  if (*c.p == '0') {
    c.p++;
  } else if (*c.p >= '1' && *c.p <= '9') {
    while (c.p < c.end && *c.p >= '0' && *c.p <= '9') c.p++;
  } else {
    c.p = start;
    return false;
  }

  if (c.p < c.end && *c.p == '.') {
    c.p++;
    if (c.p >= c.end || *c.p < '0' || *c.p > '9') { c.p = start; return false; }
    while (c.p < c.end && *c.p >= '0' && *c.p <= '9') c.p++;
  }

  if (c.p < c.end && (*c.p == 'e' || *c.p == 'E')) {
    c.p++;
    if (c.p < c.end && (*c.p == '+' || *c.p == '-')) c.p++;
    if (c.p >= c.end || *c.p < '0' || *c.p > '9') { c.p = start; return false; }
    while (c.p < c.end && *c.p >= '0' && *c.p <= '9') c.p++;
  }

  // parse to double
  std::string tmp(start, c.p - start);
  char* endptr = nullptr;
  errno = 0;
  out = std::strtod(tmp.c_str(), &endptr);
  if (errno != 0 || endptr == tmp.c_str()) { c.p = start; return false; }
  return true;
}

static bool parse_value(ParseCtx& c, JValue& out);

static bool parse_array(ParseCtx& c, JValue& out) {
  if (c.p >= c.end || *c.p != '[') return false;
  c.p++;
  out.type = JValue::Type::Array;
  out.arr.clear();
  skip_ws(c);
  if (c.p < c.end && *c.p == ']') { c.p++; return true; }

  while (true) {
    skip_ws(c);
    JValue v;
    if (!parse_value(c, v)) return false;
    out.arr.emplace_back(std::move(v));
    skip_ws(c);
    if (c.p >= c.end) return false;
    if (*c.p == ',') { c.p++; continue; }
    if (*c.p == ']') { c.p++; return true; }
    return false;
  }
}

static bool parse_object(ParseCtx& c, JValue& out) {
  if (c.p >= c.end || *c.p != '{') return false;
  c.p++;
  out.type = JValue::Type::Object;
  out.obj.clear();
  skip_ws(c);
  if (c.p < c.end && *c.p == '}') { c.p++; return true; }

  while (true) {
    skip_ws(c);
    std::string key;
    if (!parse_string(c, key)) return false;
    skip_ws(c);
    if (c.p >= c.end || *c.p != ':') return false;
    c.p++;
    skip_ws(c);
    JValue v;
    if (!parse_value(c, v)) return false;
    out.obj.emplace_back(std::move(key), std::move(v));
    skip_ws(c);
    if (c.p >= c.end) return false;
    if (*c.p == ',') { c.p++; continue; }
    if (*c.p == '}') { c.p++; return true; }
    return false;
  }
}

static bool parse_value(ParseCtx& c, JValue& out) {
  skip_ws(c);
  if (c.p >= c.end) return false;
  const char ch = *c.p;
  if (ch == '"') {
    out.type = JValue::Type::String;
    return parse_string(c, out.str);
  }
  if (ch == '{') return parse_object(c, out);
  if (ch == '[') return parse_array(c, out);
  if (ch == 't') { out.type = JValue::Type::Bool; out.b = true; return parse_literal(c, "true"); }
  if (ch == 'f') { out.type = JValue::Type::Bool; out.b = false; return parse_literal(c, "false"); }
  if (ch == 'n') { out.type = JValue::Type::Null; return parse_literal(c, "null"); }
  // number
  out.type = JValue::Type::Number;
  return parse_number(c, out.num);
}

static bool parse_json(const std::string& s, JValue& out) {
  ParseCtx c{ s.data(), s.data() + s.size() };
  if (!parse_value(c, out)) return false;
  skip_ws(c);
  return c.p == c.end;
}

// noise slicing similar to TS sliceStr (best-effort)
static std::string slice_str_best_effort(const std::string& o) {
  const std::string marker = "∆˚ø";
  auto z = o.find(marker);
  if (z != std::string::npos) return o.substr(z);

  std::vector<size_t> idx;
  auto a = o.find("[\"");
  auto b = o.find("{\"");
  auto c = o.find("[[");
  auto d = o.find("[[[");
  if (a != std::string::npos) idx.push_back(a);
  if (b != std::string::npos) idx.push_back(b);
  if (c != std::string::npos) idx.push_back(c);
  if (d != std::string::npos) idx.push_back(d);
  if (idx.empty()) return o;
  size_t m = idx[0];
  for (size_t i : idx) if (i < m) m = i;
  if (m == 0) return o;
  return o.substr(m);
}

// -----------------------------
// Worker + TSFN messaging
// -----------------------------

struct ParsedItem {
  bool ok = false;
  JValue value;
  std::string raw;
  uint32_t byte_count = 0;
};

struct BatchMsg {
  enum class Kind { Data, NonJson, End, Error } kind = Kind::Data;
  std::vector<ParsedItem> items;
  std::string error_message;
  // stats
  uint64_t bytes_read = 0;
  uint64_t bytes_written = 0;
  uint64_t lines_ok = 0;
  uint64_t lines_failed = 0;
};

struct ParserOptions {
  std::string delimiter = "\n";
  uint32_t batch_size = 64;
  bool debug = false;
  bool wrap_metadata = false;
  bool include_raw_string = false;
  bool include_byte_count = false;
  bool emit_non_json = false;
  bool track_bytes_read = false;
  bool track_bytes_written = false;
  bool clean_front = true;
  bool lazy_handles = false;
};

struct ParserInstance {
  napi_env env = nullptr;
  napi_threadsafe_function tsfn = nullptr;

  ParserOptions opts;

  std::atomic<bool> stop{false};
  std::atomic<bool> ended{false};

  int fd = -1;     // original (not owned)
  int fd_dup = -1; // owned (read loop uses this)
  std::thread worker;

  std::atomic<uint64_t> bytes_read{0};
  std::atomic<uint64_t> bytes_written{0};
  std::atomic<uint64_t> lines_ok{0};
  std::atomic<uint64_t> lines_failed{0};

  // symbol keys (optional)
  napi_ref raw_string_symbol_ref = nullptr;
  napi_ref raw_bytes_symbol_ref = nullptr;
};

static napi_value jvalue_to_js(napi_env env, const JValue& v);
static napi_value get_symbol_or_fallback_key(napi_env env, napi_ref sym_ref, const char* fallback);

// -----------------------------
// Lazy handle object (native-backed, materialize on demand)
// -----------------------------

struct HandleWrap {
  JValue value;
  std::string raw;
  uint32_t byte_count = 0;
  bool wrap_metadata = false;
  bool include_raw_string = false;
  bool include_byte_count = false;
  napi_ref raw_string_symbol_ref = nullptr;
  napi_ref raw_bytes_symbol_ref = nullptr;
};

static napi_ref g_handle_ctor_ref = nullptr;

static void handle_finalize(napi_env env, void* data, void* /*hint*/) {
  auto* hw = static_cast<HandleWrap*>(data);
  if (!hw) return;
  if (hw->raw_string_symbol_ref) {
    napi_delete_reference(env, hw->raw_string_symbol_ref);
    hw->raw_string_symbol_ref = nullptr;
  }
  if (hw->raw_bytes_symbol_ref) {
    napi_delete_reference(env, hw->raw_bytes_symbol_ref);
    hw->raw_bytes_symbol_ref = nullptr;
  }
  delete hw;
}

static napi_value handle_to_js(napi_env env, napi_callback_info info) {
  napi_value self;
  size_t argc = 0;
  napi_get_cb_info(env, info, &argc, nullptr, &self, nullptr);

  HandleWrap* hw = nullptr;
  napi_unwrap(env, self, reinterpret_cast<void**>(&hw));
  if (!hw) {
    napi_throw_error(env, nullptr, "NativeJsonHandle missing native state");
    return nullptr;
  }

  ParsedItem tmp;
  tmp.ok = true;
  tmp.raw = hw->raw;
  tmp.byte_count = hw->byte_count;

  napi_value parsed_val = jvalue_to_js(env, hw->value);

  if (hw->wrap_metadata) {
    napi_value wrapper;
    napi_create_object(env, &wrapper);
    napi_set_named_property(env, wrapper, "value", parsed_val);

    // attach metadata onto wrapper
    if (hw->include_byte_count) {
      napi_value k = get_symbol_or_fallback_key(env, hw->raw_bytes_symbol_ref, "rawJsonBytes");
      napi_value v = make_uint32(env, tmp.byte_count);
      napi_set_property(env, wrapper, k, v);
    }
    if (hw->include_raw_string) {
      napi_value k = get_symbol_or_fallback_key(env, hw->raw_string_symbol_ref, "rawString");
      napi_value v = make_string(env, tmp.raw);
      napi_set_property(env, wrapper, k, v);
    }

    return wrapper;
  }

  // attach metadata directly if JS value is object-like
  napi_valuetype t;
  napi_typeof(env, parsed_val, &t);
  if (t == napi_object) {
    if (hw->include_byte_count) {
      napi_value k = get_symbol_or_fallback_key(env, hw->raw_bytes_symbol_ref, "rawJsonBytes");
      napi_value v = make_uint32(env, tmp.byte_count);
      napi_set_property(env, parsed_val, k, v);
    }
    if (hw->include_raw_string) {
      napi_value k = get_symbol_or_fallback_key(env, hw->raw_string_symbol_ref, "rawString");
      napi_value v = make_string(env, tmp.raw);
      napi_set_property(env, parsed_val, k, v);
    }
  }

  return parsed_val;
}

static napi_value handle_ctor(napi_env env, napi_callback_info info) {
  napi_value self;
  size_t argc = 0;
  napi_get_cb_info(env, info, &argc, nullptr, &self, nullptr);
  return self;
}

static napi_value new_handle_instance(napi_env env, HandleWrap* hw) {
  napi_value ctor;
  napi_get_reference_value(env, g_handle_ctor_ref, &ctor);
  napi_value inst;
  napi_new_instance(env, ctor, 0, nullptr, &inst);
  napi_wrap(env, inst, hw, handle_finalize, nullptr, nullptr);
  return inst;
}

static napi_value jvalue_object_to_js(napi_env env, const JValue& v) {
  napi_value obj;
  napi_create_object(env, &obj);
  for (const auto& kv : v.obj) {
    napi_value val = jvalue_to_js(env, kv.second);
    // Avoid allocating a JS string for the key in the common case.
    // NOTE: napi_set_named_property requires a NUL-terminated UTF-8 C string.
    // JSON keys can technically contain \u0000; fallback to set_property in that rare case.
    if (kv.first.find('\0') == std::string::npos) {
      napi_set_named_property(env, obj, kv.first.c_str(), val);
    } else {
      napi_value key = make_string(env, kv.first);
      napi_set_property(env, obj, key, val);
    }
  }
  return obj;
}

static napi_value jvalue_array_to_js(napi_env env, const JValue& v) {
  napi_value arr;
  napi_create_array_with_length(env, v.arr.size(), &arr);
  for (size_t i = 0; i < v.arr.size(); i++) {
    napi_value val = jvalue_to_js(env, v.arr[i]);
    napi_set_element(env, arr, i, val);
  }
  return arr;
}

static napi_value jvalue_to_js(napi_env env, const JValue& v) {
  switch (v.type) {
    case JValue::Type::Null: {
      napi_value n;
      napi_get_null(env, &n);
      return n;
    }
    case JValue::Type::Bool:
      return make_bool(env, v.b);
    case JValue::Type::Number:
      return make_double(env, v.num);
    case JValue::Type::String:
      return make_string(env, v.str);
    case JValue::Type::Array:
      return jvalue_array_to_js(env, v);
    case JValue::Type::Object:
      return jvalue_object_to_js(env, v);
  }
  napi_value u;
  napi_get_undefined(env, &u);
  return u;
}

static napi_value get_symbol_or_fallback_key(napi_env env, napi_ref sym_ref, const char* fallback) {
  if (sym_ref) {
    napi_value sym;
    napi_get_reference_value(env, sym_ref, &sym);
    return sym;
  }
  napi_value k;
  napi_create_string_utf8(env, fallback, NAPI_AUTO_LENGTH, &k);
  return k;
}

static void attach_metadata(
  napi_env env,
  ParserInstance* inst,
  napi_value target_obj,
  const ParsedItem& item
) {
  if (inst->opts.include_byte_count) {
    napi_value k = get_symbol_or_fallback_key(env, inst->raw_bytes_symbol_ref, "rawJsonBytes");
    napi_value v = make_uint32(env, item.byte_count);
    napi_set_property(env, target_obj, k, v);
  }
  if (inst->opts.include_raw_string) {
    napi_value k = get_symbol_or_fallback_key(env, inst->raw_string_symbol_ref, "rawString");
    napi_value v = make_string(env, item.raw);
    napi_set_property(env, target_obj, k, v);
  }
}

// We need ParserInstance inside TSFN callback for metadata/wrap behavior.
// N-API gives us a `context` pointer. We'll use it.
static void call_js_from_tsfn_with_instance(napi_env env, napi_value js_cb, void* context, void* data) {
  auto* inst = static_cast<ParserInstance*>(context);
  auto* msg = static_cast<BatchMsg*>(data);

  napi_value msg_obj;
  napi_create_object(env, &msg_obj);

  auto set_str = [&](const char* k, const std::string& s) {
    napi_value key;
    napi_create_string_utf8(env, k, NAPI_AUTO_LENGTH, &key);
    napi_value val = make_string(env, s);
    napi_set_property(env, msg_obj, key, val);
  };
  auto set_u64 = [&](const char* k, uint64_t n) {
    napi_value key;
    napi_create_string_utf8(env, k, NAPI_AUTO_LENGTH, &key);
    napi_value val;
    napi_create_double(env, static_cast<double>(n), &val);
    napi_set_property(env, msg_obj, key, val);
  };

  if (msg->kind == BatchMsg::Kind::Data || msg->kind == BatchMsg::Kind::NonJson) {
    set_str("type", msg->kind == BatchMsg::Kind::Data ? "data" : "string");

    napi_value arr;
    napi_create_array_with_length(env, msg->items.size(), &arr);

    for (size_t i = 0; i < msg->items.size(); i++) {
      auto& it = msg->items[i];
      napi_value v;
      if (msg->kind == BatchMsg::Kind::NonJson) {
        v = make_string(env, it.raw);
      } else {
        if (inst->opts.lazy_handles) {
          auto* hw = new HandleWrap();
          hw->value = std::move(it.value);
          hw->byte_count = it.byte_count;
          hw->wrap_metadata = inst->opts.wrap_metadata;
          hw->include_raw_string = inst->opts.include_raw_string;
          hw->include_byte_count = inst->opts.include_byte_count;
          if (hw->include_raw_string) {
            hw->raw = std::move(it.raw);
          }
          if (inst->raw_string_symbol_ref) {
            napi_value sym;
            napi_get_reference_value(env, inst->raw_string_symbol_ref, &sym);
            napi_create_reference(env, sym, 1, &hw->raw_string_symbol_ref);
          }
          if (inst->raw_bytes_symbol_ref) {
            napi_value sym;
            napi_get_reference_value(env, inst->raw_bytes_symbol_ref, &sym);
            napi_create_reference(env, sym, 1, &hw->raw_bytes_symbol_ref);
          }
          v = new_handle_instance(env, hw);
        } else {
          napi_value parsed_val = jvalue_to_js(env, it.value);
          if (inst->opts.wrap_metadata) {
            napi_value wrapper;
            napi_create_object(env, &wrapper);
            napi_set_named_property(env, wrapper, "value", parsed_val);
            attach_metadata(env, inst, wrapper, it);
            v = wrapper;
          } else {
            // attach metadata only if JS value is an object (arrays count as objects)
            napi_valuetype t;
            napi_typeof(env, parsed_val, &t);
            if (t == napi_object) {
              attach_metadata(env, inst, parsed_val, it);
            }
            v = parsed_val;
          }
        }
      }
      napi_set_element(env, arr, i, v);
    }

    napi_value batch_key;
    napi_create_string_utf8(env, "batch", NAPI_AUTO_LENGTH, &batch_key);
    napi_set_property(env, msg_obj, batch_key, arr);
  } else if (msg->kind == BatchMsg::Kind::End) {
    set_str("type", "end");
    set_u64("bytesRead", msg->bytes_read);
    set_u64("bytesWritten", msg->bytes_written);
    set_u64("linesOk", msg->lines_ok);
    set_u64("linesFailed", msg->lines_failed);
  } else if (msg->kind == BatchMsg::Kind::Error) {
    set_str("type", "error");
    set_str("message", msg->error_message);
  }

  napi_value undefined;
  napi_get_undefined(env, &undefined);

  napi_value argv[1] = { msg_obj };
  napi_call_function(env, undefined, js_cb, 1, argv, nullptr);

  delete msg;
}

static void parser_thread_main(ParserInstance* inst) {
  // duplicate fd so stop() can close it to break a blocking read
  inst->fd_dup = dup(inst->fd);
  if (inst->fd_dup < 0) {
    auto* msg = new BatchMsg();
    msg->kind = BatchMsg::Kind::Error;
    msg->error_message = "dup(fd) failed";
    napi_call_threadsafe_function(inst->tsfn, msg, napi_tsfn_blocking);
    // send end stats and release
    auto* end_msg = new BatchMsg();
    end_msg->kind = BatchMsg::Kind::End;
    end_msg->bytes_read = inst->bytes_read.load();
    end_msg->bytes_written = inst->bytes_written.load();
    end_msg->lines_ok = inst->lines_ok.load();
    end_msg->lines_failed = inst->lines_failed.load();
    napi_call_threadsafe_function(inst->tsfn, end_msg, napi_tsfn_blocking);
    napi_release_threadsafe_function(inst->tsfn, napi_tsfn_release);
    inst->ended.store(true);
    return;
  }

  const size_t BUF_SZ = 64 * 1024;
  std::vector<char> buf(BUF_SZ);
  std::string pending;
  pending.reserve(BUF_SZ * 2);

  std::vector<ParsedItem> batch;
  batch.reserve(inst->opts.batch_size);

  auto flush_batch = [&]() {
    if (batch.empty()) return;
    auto* msg = new BatchMsg();
    msg->kind = BatchMsg::Kind::Data;
    msg->items = std::move(batch);
    batch.clear();
    batch.reserve(inst->opts.batch_size);
    napi_call_threadsafe_function(inst->tsfn, msg, napi_tsfn_blocking);
  };

  auto flush_nonjson = [&](std::vector<ParsedItem>& nonjson_items) {
    if (nonjson_items.empty()) return;
    auto* msg = new BatchMsg();
    msg->kind = BatchMsg::Kind::NonJson;
    msg->items = std::move(nonjson_items);
    nonjson_items.clear();
    napi_call_threadsafe_function(inst->tsfn, msg, napi_tsfn_blocking);
  };

  std::vector<ParsedItem> nonjson_batch;
  nonjson_batch.reserve(inst->opts.batch_size);

  const std::string delim = inst->opts.delimiter.empty() ? std::string("\n") : inst->opts.delimiter;

  while (!inst->stop.load()) {
    ssize_t n = read(inst->fd_dup, buf.data(), BUF_SZ);
    if (n == 0) break; // EOF
    if (n < 0) {
      if (errno == EINTR) continue;
      if (errno == EAGAIN || errno == EWOULDBLOCK) {
        // Some pipes/sockets can be non-blocking (e.g. handles from child_process).
        // Avoid busy-spinning.
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
        continue;
      }
      if (inst->stop.load()) break;
      auto* msg = new BatchMsg();
      msg->kind = BatchMsg::Kind::Error;
      msg->error_message = std::string("read(fd) failed: ") + std::strerror(errno);
      napi_call_threadsafe_function(inst->tsfn, msg, napi_tsfn_blocking);
      break;
    }

    if (inst->opts.track_bytes_read) {
      inst->bytes_read.fetch_add(static_cast<uint64_t>(n));
    }

    pending.append(buf.data(), static_cast<size_t>(n));

    // split by delimiter without repeatedly erasing
    size_t start = 0;
    while (true) {
      size_t pos = pending.find(delim, start);
      if (pos == std::string::npos) {
        if (start > 0) pending.erase(0, start);
        break;
      }

      std::string line = pending.substr(start, pos - start);
      start = pos + delim.size();

      if (line.empty()) continue;

      std::string candidate = line;
      if (inst->opts.clean_front) {
        if (!(candidate.size() >= 2 && (candidate[0] == '{' || candidate[0] == '[') && candidate[1] == '"')) {
          candidate = slice_str_best_effort(candidate);
        }
      }

      ParsedItem item;
      item.byte_count = static_cast<uint32_t>(candidate.size());

      JValue parsed;
      if (parse_json(candidate, parsed)) {
        item.ok = true;
        item.value = std::move(parsed);
        if (inst->opts.include_raw_string) {
          item.raw = candidate;
        }
        batch.emplace_back(std::move(item));
        inst->lines_ok.fetch_add(1);
        if (inst->opts.track_bytes_written) {
          inst->bytes_written.fetch_add(static_cast<uint64_t>(item.byte_count));
        }
        if (batch.size() >= inst->opts.batch_size) flush_batch();
      } else {
        inst->lines_failed.fetch_add(1);
        if (inst->opts.emit_non_json) {
          item.ok = false;
          item.raw = candidate;
          nonjson_batch.emplace_back(std::move(item));
          if (nonjson_batch.size() >= inst->opts.batch_size) flush_nonjson(nonjson_batch);
        }
      }
    }
  }

  // flush remaining pending as one last line (like TS _flush)
  if (!inst->stop.load() && !pending.empty()) {
    std::string candidate = pending;
    if (inst->opts.clean_front) {
      if (!(candidate.size() >= 2 && (candidate[0] == '{' || candidate[0] == '[') && candidate[1] == '"')) {
        candidate = slice_str_best_effort(candidate);
      }
    }

    ParsedItem item;
    item.byte_count = static_cast<uint32_t>(candidate.size());
    JValue parsed;
    if (parse_json(candidate, parsed)) {
      item.ok = true;
      item.value = std::move(parsed);
      if (inst->opts.include_raw_string) {
        item.raw = candidate;
      }
      batch.emplace_back(std::move(item));
      inst->lines_ok.fetch_add(1);
      if (inst->opts.track_bytes_written) {
        inst->bytes_written.fetch_add(static_cast<uint64_t>(item.byte_count));
      }
    } else {
      inst->lines_failed.fetch_add(1);
      if (inst->opts.emit_non_json) {
        item.ok = false;
        item.raw = candidate;
        nonjson_batch.emplace_back(std::move(item));
      }
    }
  }

  flush_batch();
  flush_nonjson(nonjson_batch);

  if (inst->fd_dup >= 0) {
    close(inst->fd_dup);
    inst->fd_dup = -1;
  }

  // send end stats
  auto* end_msg = new BatchMsg();
  end_msg->kind = BatchMsg::Kind::End;
  end_msg->bytes_read = inst->bytes_read.load();
  end_msg->bytes_written = inst->bytes_written.load();
  end_msg->lines_ok = inst->lines_ok.load();
  end_msg->lines_failed = inst->lines_failed.load();
  napi_call_threadsafe_function(inst->tsfn, end_msg, napi_tsfn_blocking);

  // decrement TSFN thread count
  napi_release_threadsafe_function(inst->tsfn, napi_tsfn_release);

  inst->ended.store(true);
}

// -----------------------------
// N-API class wrapper
// -----------------------------

static void parser_finalize(napi_env env, void* data, void* /*hint*/) {
  auto* inst = static_cast<ParserInstance*>(data);
  if (!inst) return;

  inst->stop.store(true);
  if (inst->fd_dup >= 0) {
    close(inst->fd_dup);
    inst->fd_dup = -1;
  }

  if (inst->worker.joinable()) {
    inst->worker.join();
  }

  if (inst->raw_string_symbol_ref) {
    napi_delete_reference(env, inst->raw_string_symbol_ref);
    inst->raw_string_symbol_ref = nullptr;
  }
  if (inst->raw_bytes_symbol_ref) {
    napi_delete_reference(env, inst->raw_bytes_symbol_ref);
    inst->raw_bytes_symbol_ref = nullptr;
  }

  delete inst;
}

// JS: new FdJsonParser(fd:number, opts:object, onMessage:(msg)=>void)
static napi_value fd_json_parser_ctor(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  napi_value self;
  napi_get_cb_info(env, info, &argc, argv, &self, nullptr);

  if (argc < 3) {
    napi_throw_type_error(env, nullptr, "FdJsonParser(fd, opts, onMessage) requires 3 arguments");
    return nullptr;
  }

  int32_t fd = -1;
  napi_get_value_int32(env, argv[0], &fd);
  if (fd < 0) {
    napi_throw_type_error(env, nullptr, "fd must be a non-negative integer");
    return nullptr;
  }

  napi_value opts = argv[1];
  napi_value cb = argv[2];
  if (!is_napi_function(env, cb)) {
    napi_throw_type_error(env, nullptr, "onMessage must be a function");
    return nullptr;
  }

  auto* inst = new ParserInstance();
  inst->env = env;
  inst->fd = fd;

  // opts parsing (best-effort)
  auto get_bool = [&](const char* key, bool& out) {
    bool has = false;
    napi_has_named_property(env, opts, key, &has);
    if (!has) return;
    napi_value v;
    napi_get_named_property(env, opts, key, &v);
    bool b = false;
    napi_get_value_bool(env, v, &b);
    out = b;
  };
  auto get_u32 = [&](const char* key, uint32_t& out) {
    bool has = false;
    napi_has_named_property(env, opts, key, &has);
    if (!has) return;
    napi_value v;
    napi_get_named_property(env, opts, key, &v);
    uint32_t n = 0;
    napi_get_value_uint32(env, v, &n);
    out = n;
  };
  auto get_str = [&](const char* key, std::string& out) {
    bool has = false;
    napi_has_named_property(env, opts, key, &has);
    if (!has) return;
    napi_value v;
    napi_get_named_property(env, opts, key, &v);
    size_t len = 0;
    napi_get_value_string_utf8(env, v, nullptr, 0, &len);
    std::string s;
    s.resize(len);
    napi_get_value_string_utf8(env, v, s.data(), len + 1, &len);
    out = s;
  };

  get_str("delimiter", inst->opts.delimiter);
  get_u32("batchSize", inst->opts.batch_size);
  if (inst->opts.batch_size == 0) inst->opts.batch_size = 64;
  get_bool("debug", inst->opts.debug);
  get_bool("wrapMetadata", inst->opts.wrap_metadata);
  get_bool("includeRawString", inst->opts.include_raw_string);
  get_bool("includeByteCount", inst->opts.include_byte_count);
  get_bool("emitNonJSON", inst->opts.emit_non_json);
  get_bool("trackBytesRead", inst->opts.track_bytes_read);
  get_bool("trackBytesWritten", inst->opts.track_bytes_written);
  get_bool("lazyHandles", inst->opts.lazy_handles);

  // Optional symbol keys passed from JS:
  // opts.rawStringSymbol, opts.rawJsonBytesSymbol
  {
    bool has = false;
    napi_has_named_property(env, opts, "rawStringSymbol", &has);
    if (has) {
      napi_value sym;
      napi_get_named_property(env, opts, "rawStringSymbol", &sym);
      napi_create_reference(env, sym, 1, &inst->raw_string_symbol_ref);
    }
  }
  {
    bool has = false;
    napi_has_named_property(env, opts, "rawJsonBytesSymbol", &has);
    if (has) {
      napi_value sym;
      napi_get_named_property(env, opts, "rawJsonBytesSymbol", &sym);
      napi_create_reference(env, sym, 1, &inst->raw_bytes_symbol_ref);
    }
  }

  // Create TSFN with inst as context.
  napi_value resource_name;
  napi_create_string_utf8(env, "FdJsonParserTSFN", NAPI_AUTO_LENGTH, &resource_name);

  napi_status st = napi_create_threadsafe_function(
    env,
    cb,
    nullptr,
    resource_name,
    0,   // max_queue_size (0 => unlimited)
    1,   // initial_thread_count
    nullptr,
    nullptr,
    inst, // context (ParserInstance*)
    call_js_from_tsfn_with_instance,
    &inst->tsfn
  );
  if (st != napi_ok) {
    delete inst;
    napi_throw_last_error(env, "napi_create_threadsafe_function failed");
    return nullptr;
  }

  // Wrap native instance
  napi_wrap(env, self, inst, parser_finalize, nullptr, nullptr);

  // start thread
  inst->worker = std::thread(parser_thread_main, inst);

  return self;
}

static napi_value fd_json_parser_stop(napi_env env, napi_callback_info info) {
  napi_value self;
  size_t argc = 0;
  napi_get_cb_info(env, info, &argc, nullptr, &self, nullptr);

  ParserInstance* inst = nullptr;
  napi_unwrap(env, self, reinterpret_cast<void**>(&inst));
  if (!inst) {
    napi_throw_error(env, nullptr, "Native instance missing");
    return nullptr;
  }

  inst->stop.store(true);
  if (inst->fd_dup >= 0) {
    close(inst->fd_dup);
    inst->fd_dup = -1;
  }

  if (inst->worker.joinable()) {
    inst->worker.join();
  }

  napi_value undefined;
  napi_get_undefined(env, &undefined);
  return undefined;
}

static napi_value fd_json_parser_get_stats(napi_env env, napi_callback_info info) {
  napi_value self;
  size_t argc = 0;
  napi_get_cb_info(env, info, &argc, nullptr, &self, nullptr);

  ParserInstance* inst = nullptr;
  napi_unwrap(env, self, reinterpret_cast<void**>(&inst));
  if (!inst) {
    napi_throw_error(env, nullptr, "Native instance missing");
    return nullptr;
  }

  napi_value out;
  napi_create_object(env, &out);

  auto set_u64 = [&](const char* k, uint64_t n) {
    napi_value key;
    napi_create_string_utf8(env, k, NAPI_AUTO_LENGTH, &key);
    napi_value val;
    napi_create_double(env, static_cast<double>(n), &val);
    napi_set_property(env, out, key, val);
  };
  auto set_bool = [&](const char* k, bool b) {
    napi_value key;
    napi_create_string_utf8(env, k, NAPI_AUTO_LENGTH, &key);
    napi_value val = make_bool(env, b);
    napi_set_property(env, out, key, val);
  };

  set_u64("bytesRead", inst->bytes_read.load());
  set_u64("bytesWritten", inst->bytes_written.load());
  set_u64("linesOk", inst->lines_ok.load());
  set_u64("linesFailed", inst->lines_failed.load());
  set_bool("ended", inst->ended.load());

  return out;
}

static napi_value init(napi_env env, napi_value exports) {
  // NativeJsonHandle
  napi_property_descriptor handle_proto[] = {
    { "toJS", 0, handle_to_js, 0, 0, 0, napi_default, 0 }
  };

  napi_value handle_ctor_val;
  napi_define_class(
    env,
    "NativeJsonHandle",
    NAPI_AUTO_LENGTH,
    handle_ctor,
    nullptr,
    sizeof(handle_proto) / sizeof(handle_proto[0]),
    handle_proto,
    &handle_ctor_val
  );
  napi_create_reference(env, handle_ctor_val, 1, &g_handle_ctor_ref);
  napi_set_named_property(env, exports, "NativeJsonHandle", handle_ctor_val);

  napi_property_descriptor proto_props[] = {
    { "stop", 0, fd_json_parser_stop, 0, 0, 0, napi_default, 0 },
    { "getStats", 0, fd_json_parser_get_stats, 0, 0, 0, napi_default, 0 }
  };

  napi_value ctor;
  napi_define_class(
    env,
    "FdJsonParser",
    NAPI_AUTO_LENGTH,
    fd_json_parser_ctor,
    nullptr,
    sizeof(proto_props) / sizeof(proto_props[0]),
    proto_props,
    &ctor
  );

  napi_set_named_property(env, exports, "FdJsonParser", ctor);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, init)


