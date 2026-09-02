#!/bin/zsh
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "没有检测到 Node.js。请先安装 Node.js 20 或更高版本，然后重新双击本文件。"
  echo "下载地址：https://nodejs.org/"
  read "?按回车键关闭..."
  exit 1
fi
if [ ! -d node_modules ]; then
  echo "首次启动，正在安装依赖..."
  npm install || { echo "依赖安装失败，请检查网络。"; read "?按回车键关闭..."; exit 1; }
fi
echo "启动后请在浏览器打开 http://127.0.0.1:8787"
npm start
