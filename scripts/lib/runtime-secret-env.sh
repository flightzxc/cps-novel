#!/usr/bin/env bash

# Load NAME from NAME_FILE without ever printing its value. Direct env input
# remains supported for local X8. Deployment environments must choose exactly
# one source so stale env material cannot silently override a rotated file.
load_runtime_secret() {
  local name="$1" file_name="${1}_FILE" value="" file=""
  value="${!name:-}"
  file="${!file_name:-}"

  if [[ -n "$value" && -n "$file" ]]; then
    echo "ERROR: $name and $file_name are mutually exclusive" >&2
    return 65
  fi
  if [[ -n "$file" ]]; then
    [[ "$file" = /* && -r "$file" ]] || {
      echo "ERROR: $file_name is not an absolute readable file" >&2
      return 66
    }
    value="$(<"$file")"
    [[ "$value" != *$'\n'* && -n "$value" ]] || {
      echo "ERROR: $file_name must contain one non-empty line" >&2
      return 65
    }
    printf -v "$name" '%s' "$value"
    export "$name"
  fi
  [[ -n "$value" ]] || {
    echo "ERROR: $name or $file_name is required" >&2
    return 65
  }
}
