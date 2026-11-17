#!/usr/bin/env bash
# Understand-Anything DSH — 一键安装脚本
#
# 用法:
#   ./install.sh                 自动安装（克隆、构建、链接、安装 bundle）
#   ./install.sh --update        更新原版 + 桥接仓库
#   ./install.sh --uninstall     移除符号链接和 bridge bundle
#   ./install.sh --help          显示帮助
#
# 也可以直接在 DSH 中运行:
#   bash <(curl -fsSL https://raw.githubusercontent.com/Macavity17/understand-anything-dsh/main/install.sh)
#
# 上游: https://github.com/Egonex-AI/Understand-Anything
# 桥接: https://github.com/Macavity17/understand-anything-dsh

set -euo pipefail

# ── 配置 ──────────────────────────────────────────────
UPSTREAM_REPO="https://github.com/Egonex-AI/Understand-Anything.git"
BRIDGE_REPO="https://github.com/Macavity17/understand-anything-dsh.git"

UA_DIR="${UA_DIR:-$HOME/.understand-anything/repo}"
BRIDGE_DIR="${BRIDGE_DIR:-$HOME/.understand-anything/dsh-bridge}"
SKILLS_DIR="$UA_DIR/understand-anything-plugin/skills"
DSH_SKILLS_DIR="$HOME/.dsh/skills"

RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# ── 工具函数 ──────────────────────────────────────────
ok()   { printf "${GREEN}✓${NC} %s\n" "$*"; }
info() { printf "${BLUE}→${NC} %s\n" "$*"; }
warn() { printf "${YELLOW}⚠${NC} %s\n" "$*"; }
err()  { printf "${RED}✗${NC} %s\n" "$*" >&2; }

banner() {
  printf "\n${BLUE}╔══════════════════════════════════════════════════╗${NC}\n"
  printf "${BLUE}║${NC}  ${GREEN}Understand-Anything${NC} · ${BLUE}DSH Bridge${NC}"
  printf "                     ${BLUE}║${NC}\n"
  printf "${BLUE}║${NC}  一键安装脚本                                   ${BLUE}║${NC}\n"
  printf "${BLUE}╚══════════════════════════════════════════════════╝${NC}\n\n"
}

# ── 安装上游 UA ───────────────────────────────────────
clone_or_update_upstream() {
  if [[ -d "$UA_DIR/.git" ]]; then
    info "更新已有上游仓库: $UA_DIR"
    git -C "$UA_DIR" pull --ff-only
  else
    info "克隆上游仓库: $UPSTREAM_REPO → $UA_DIR"
    mkdir -p "$(dirname "$UA_DIR")"
    git clone "$UPSTREAM_REPO" "$UA_DIR"
  fi
}

build_upstream() {
  info "安装依赖并构建 core 包..."
  cd "$UA_DIR"
  if command -v pnpm &>/dev/null; then
    (pnpm install --frozen-lockfile 2>/dev/null || pnpm install) && \
    pnpm --filter @understand-anything/core build
  elif command -v npm &>/dev/null; then
    npm install && npm --workspace=@understand-anything/core run build
  else
    err "未找到 pnpm 或 npm。请先安装 Node.js 和 pnpm。"
    err "  https://nodejs.org/"
    err "  npm install -g pnpm"
    exit 1
  fi
  cd - >/dev/null
}

# ── 安装 DSH Bridge ───────────────────────────────────
clone_or_update_bridge() {
  if [[ -d "$BRIDGE_DIR/.git" ]]; then
    info "更新桥接仓库: $BRIDGE_DIR"
    git -C "$BRIDGE_DIR" pull --ff-only
  else
    info "克隆桥接仓库: $BRIDGE_REPO → $BRIDGE_DIR"
    mkdir -p "$(dirname "$BRIDGE_DIR")"
    git clone "$BRIDGE_REPO" "$BRIDGE_DIR"
  fi
}

# ── 建立技能符号链接 ───────────────────────────────────
link_skills() {
  if [[ ! -d "$SKILLS_DIR" ]]; then
    err "技能目录不存在: $SKILLS_DIR"
    err "请先确保上游仓库已正确克隆。"
    exit 1
  fi

  info "建立 DSH 技能符号链接..."
  mkdir -p "$DSH_SKILLS_DIR"

  local count=0
  for skill_dir in "$SKILLS_DIR"/understand*; do
    [[ -d "$skill_dir" ]] || continue
    local skill_name
    skill_name="$(basename "$skill_dir")"
    ln -sfn "$skill_dir" "$DSH_SKILLS_DIR/$skill_name"
    ok "  ~/.dsh/skills/$skill_name → $skill_dir"
    count=$((count + 1))
  done
  ok "共链接 $count 个技能"
}

unlink_skills() {
  [[ -d "$DSH_SKILLS_DIR" ]] || return 0
  info "移除技能符号链接..."
  for link in "$DSH_SKILLS_DIR"/understand*; do
    if [[ -L "$link" ]]; then
      rm -f "$link"
      ok "  已移除 $(basename "$link")"
    fi
  done
}

# ── 安装 / 移除 Bridge Bundle ─────────────────────────
install_bundle_instructions() {
  echo ""
  printf "${YELLOW}┌────────────────────────────────────────────────────┐${NC}\n"
  printf "${YELLOW}│${NC}  最后一步：在 DSH 中安装 bridge bundle               ${YELLOW}│${NC}\n"
  printf "${YELLOW}├────────────────────────────────────────────────────┤${NC}\n"
  printf "${YELLOW}│${NC}                                                    ${YELLOW}│${NC}\n"
  printf "${YELLOW}│${NC}  方式 1 — 复制这句话到 DSH 对话中:                   ${YELLOW}│${NC}\n"
  printf "${YELLOW}│${NC}                                                    ${YELLOW}│${NC}\n"
  printf "${YELLOW}│${NC}  ${GREEN}帮我用 plugin_manager 安装 ${BRIDGE_DIR}${NC} ${YELLOW}│${NC}\n"
  printf "${YELLOW}│${NC}                                                    ${YELLOW}│${NC}\n"
  printf "${YELLOW}│${NC}  方式 2 — 在 DSH 中执行 bash 命令:                   ${YELLOW}│${NC}\n"
  printf "${YELLOW}│${NC}                                                    ${YELLOW}│${NC}\n"
  printf "${YELLOW}│${NC}  ${GREEN}plugin_manager install_bundle ${BRIDGE_DIR}${NC} ${YELLOW}│${NC}\n"
  printf "${YELLOW}│${NC}                                                    ${YELLOW}│${NC}\n"
  printf "${YELLOW}└────────────────────────────────────────────────────┘${NC}\n"
  echo ""
}

# ── 命令处理 ──────────────────────────────────────────
cmd_install() {
  banner
  info "Node.js $(node --version 2>/dev/null || echo '?')"

  # 1. 上游 UA
  clone_or_update_upstream
  ok "上游仓库就绪"

  # 2. 构建 core
  build_upstream
  ok "core 包构建完成"

  # 3. 桥接仓库
  clone_or_update_bridge
  ok "桥接仓库就绪"

  # 4. 技能符号链接
  link_skills

  # 5. 安装 bundle
  echo ""
  info "安装 bridge bundle 到 DSH..."
  install_bundle_instructions
}

cmd_update() {
  clone_or_update_upstream
  build_upstream
  clone_or_update_bridge
  link_skills
  ok "更新完成。如果 bridge bundle 有变化，请在 DSH 中重新安装。"
}

cmd_uninstall() {
  unlink_skills
  if [[ -d "$BRIDGE_DIR" ]]; then
    warn "桥接仓库保留在 $BRIDGE_DIR（需在 DSH 中单独移除 bundle 后可删除）"
  fi
  if [[ -d "$UA_DIR" ]]; then
    warn "上游仓库保留在 $UA_DIR（如不再需要可手动删除）"
  fi
  ok "卸载完成"
}

cmd_dsh_install() {
  # 由 DSH 内部调用 — 运行完整 install 后告诉 DSH 安装 bundle
  cmd_install
  echo ""
  info "正在通过 plugin_manager 安装 bridge bundle..."
  # plugin_manager install_bundle 由 DSH 的 AI 代理调用，
  # 脚本层面只做文件操作；bundle 注册交给 DSH。
  ok "所有文件准备完毕。请在当前 DSH 对话中说: 帮我安装 bundle"
}

usage() {
  cat <<EOF
Understand-Anything DSH — 一键安装

用法:
  ./install.sh                 自动安装（克隆、构建、链接）
  ./install.sh --update        更新到最新版本
  ./install.sh --uninstall     移除技能链接
  ./install.sh --dsh           供 DSH 内部调用
  ./install.sh --help          显示此帮助

环境变量:
  UA_DIR       上游仓库位置（默认: ~/.understand-anything/repo）
  BRIDGE_DIR   桥接仓库位置（默认: ~/.understand-anything/dsh-bridge）

上游: https://github.com/Egonex-AI/Understand-Anything
桥接: https://github.com/Macavity17/understand-anything-dsh
EOF
}

# ── 入口 ──────────────────────────────────────────────
main() {
  case "${1:-}" in
    -h|--help)    usage ;;
    --update)     cmd_update ;;
    --uninstall)  cmd_uninstall ;;
    --dsh)        cmd_dsh_install ;;
    ""|--install) cmd_install ;;
    *)            echo "未知选项: $1"; usage >&2; exit 1 ;;
  esac
}

main "${@:-}"