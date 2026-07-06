#!/usr/bin/env bash
set -euo pipefail

# common.sh — shared helpers for the KirkForge-Plugin filesystem plugin.
# Sourced by the tool scripts; not invoked directly.

# Locate the KirkForge CLI entry point.
# 1. Installed layout: <plugin_root>/apps/cli/dist/index.js
#    (the entire KirkForge-Plugin repo is copied into ~/.local/share/kirkforge/plugins/kirkforge-plugin/)
# 2. Source layout: <plugin_root>/../../apps/cli/dist/index.js
#    (plugin/ lives inside the repo, two levels below workspace root)
# 3. Built executable on PATH via `kirkforge` or `kirkforge-plugin`
find_cli() {
    local script_dir
    script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    local candidates=(
        "${script_dir}/../apps/cli/dist/index.js"
        "${script_dir}/../../apps/cli/dist/index.js"
    )
    for c in "${candidates[@]}"; do
        if [ -f "$c" ]; then
            printf '%s' "$c"
            return 0
        fi
    done
    local path_bin
    path_bin="$(command -v kirkforge 2>/dev/null || true)"
    if [ -n "$path_bin" ]; then
        printf '%s' "$path_bin"
        return 0
    fi
    return 1
}

# Print usage error and exit non-zero.
die() {
    printf '%s\n' "$1" >&2
    exit 1
}
