#!/usr/bin/env bash
# Prepare the pinned upstream and local DSH bundle; registration is an AI tool action.
set -euo pipefail

UPSTREAM_REPO="https://github.com/Egonex-AI/Understand-Anything.git"
UPSTREAM_TAG="v2.9.8"
UPSTREAM_COMMIT="b861852dda79273bd9d2e01c3160d42e2df510d2"
BRIDGE_REPO="https://github.com/Macavity17/understand-anything-dsh.git"
UA_DIR="${UA_DIR:-$HOME/.understand-anything/repo}"
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# Prefer the repository containing this script. A downloaded standalone script
# uses a separate checkout, without ever pulling or replacing existing files.
if [[ -f "$SCRIPT_DIR/cordis.patch.yml" && -f "$SCRIPT_DIR/scripts/prepare-upstream.mjs" ]]; then
  BRIDGE_DIR="${BRIDGE_DIR:-$SCRIPT_DIR}"
else
  BRIDGE_DIR="${BRIDGE_DIR:-$HOME/.understand-anything/dsh-bridge}"
fi
NODE_BIN="${NODE_BIN:-node}"
PNPM_BIN="${PNPM_BIN:-pnpm}"

info() { printf '→ %s\n' "$*"; }
fail() { printf '✗ %s\n' "$*" >&2; exit 1; }
# PNPM_SCRIPT supports the bundled DSH runtime: NODE_BIN /absolute/pnpm.mjs.
pnpm_run() {
  if [[ -n "${PNPM_SCRIPT:-}" ]]; then
    "$NODE_BIN" "$PNPM_SCRIPT" "$@"
  else
    "$PNPM_BIN" "$@"
  fi
}

usage() {
  printf '%s\n' \
    'Understand-Anything DSH — 固定版本安全安装' \
    '用法: ./install.sh [--install|--update|--dsh|--uninstall|--help]' \
    '要求: Node.js >=22、pnpm >=10、git（仅克隆时）' \
    'UA_DIR: 上游根目录，默认 ~/.understand-anything/repo' \
    'BRIDGE_DIR: bridge 根目录，默认当前安装脚本所在仓库' \
    'NODE_BIN / PNPM_BIN: 运行时可执行文件；PNPM_SCRIPT: pnpm.mjs 路径' \
    '--update 只重复准备及构建，不执行 git pull/fetch/checkout。' \
    '仅支持上游 2.9.8；新克隆固定到 v2.9.8 的已验证提交。' \
    '不创建或删除 ~/.dsh/skills；技能由 bundle Host 注册。' \
    '不会安装 bundle、启动 dashboard 或更改 token 验证。'
}

check_runtime() {
  command -v "$NODE_BIN" >/dev/null 2>&1 || fail '缺少 Node.js；需要 >=22。'
  "$NODE_BIN" --input-type=module -e 'if (Number(process.versions.node.split(".")[0]) < 22) { console.error("需要 Node.js >=22"); process.exit(1); }'
  local version
  version="$(pnpm_run --version)" || fail '缺少 pnpm >=10；不支持 npm workspace fallback。'
  [[ "$version" =~ ^([0-9]+)\. ]] || fail "无法识别 pnpm 版本: $version"
  [[ "${BASH_REMATCH[1]}" -ge 10 ]] || fail "需要 pnpm >=10（当前 ${version}）；不支持 npm workspace fallback。"
  info "Node.js $("$NODE_BIN" --version), pnpm $version"
}

prepare_bridge() {
  if [[ -e "$BRIDGE_DIR" || -L "$BRIDGE_DIR" ]]; then
    [[ -d "$BRIDGE_DIR" && -f "$BRIDGE_DIR/cordis.patch.yml" && -f "$BRIDGE_DIR/scripts/prepare-upstream.mjs" ]] || fail "bridge 目录未知或不完整；保留原样: $BRIDGE_DIR"
    info "使用现有 bridge，不自动拉取或覆盖: $BRIDGE_DIR"
  else
    command -v git >/dev/null 2>&1 || fail '克隆需要 git。'
    mkdir -p -- "$(dirname -- "$BRIDGE_DIR")"
    git clone -- "$BRIDGE_REPO" "$BRIDGE_DIR"
    [[ -f "$BRIDGE_DIR/scripts/prepare-upstream.mjs" ]] || fail "bridge 缺少 prepare-upstream.mjs: $BRIDGE_DIR"
  fi
}

prepare_upstream() {
  if [[ -e "$UA_DIR" || -L "$UA_DIR" ]]; then
    [[ -d "$UA_DIR" && -f "$UA_DIR/understand-anything-plugin/.claude-plugin/plugin.json" ]] || fail "上游目录未知或不完整；保留原样: $UA_DIR"
    info "使用现有上游，不执行 git pull/fetch/checkout: $UA_DIR"
  else
    command -v git >/dev/null 2>&1 || fail '克隆需要 git。'
    mkdir -p -- "$(dirname -- "$UA_DIR")"
    git clone --depth 1 --branch "$UPSTREAM_TAG" -- "$UPSTREAM_REPO" "$UA_DIR"
    [[ "$(git -C "$UA_DIR" rev-parse HEAD)" == "$UPSTREAM_COMMIT" ]] || fail '上游标签提交不匹配；拒绝继续（克隆目录保留以供检查）。'
  fi
  "$NODE_BIN" "$BRIDGE_DIR/scripts/prepare-upstream.mjs" --upstream "$UA_DIR"
}

build_upstream() {
  info '使用冻结锁文件安装依赖，然后构建 core 和正常 dashboard（非 demo 模式）...'
  (
    cd -- "$UA_DIR"
    pnpm_run install --frozen-lockfile
    pnpm_run --filter @understand-anything/core build
    VITE_DEMO_MODE=false pnpm_run --filter @understand-anything/dashboard build
  )
}

bundle_instructions() {
  info '文件及 core/dashboard 已准备完成；尚未安装或注册 bundle。'
  printf '\n%s\n' \
    '最后一步：请把下面请求发送给 DSH AI（plugin_manager 是 AI 工具，不是 shell 命令）：' \
    "请先用 plugin_manager 的 list_bundles 确认已有 bundle，再用 install_bundle 安装本地目录 ${BRIDGE_DIR}。" \
    "如需指定上游，安装后将 bundle 的 upstreamRoot 配置为 ${UA_DIR}/understand-anything-plugin。" \
    '工具调用格式（不是 bash）：'
  "$NODE_BIN" --input-type=module -e 'console.log(JSON.stringify({ action: "install_bundle", target: process.argv[1] }, null, 2))' "$BRIDGE_DIR"
  printf '%s\n' '若工具返回待批准安装脚本、版本不兼容或需重启，请按返回状态处理；本脚本不会绕过。' \
    '运行 dashboard 时保留正常 token 模式，使用启动日志中的 /?token=… URL；勿使用 build:demo。'
}

install() {
  check_runtime
  prepare_bridge
  prepare_upstream
  build_upstream
  bundle_instructions
}

main() {
  [[ $# -le 1 ]] || fail '只接受一个选项；请查看 --help。'
  case "${1:-}" in
    -h|--help) usage ;;
    ''|--install|--update|--dsh) install ;;
    --uninstall)
      info '不删除任何仓库或技能路径。请让 DSH AI 用 plugin_manager list_bundles 确认后 remove_bundle；Host 随卸载清理其注册技能。'
      ;;
    *) fail "未知选项: $1（使用 --help）" ;;
  esac
}
main "$@"
