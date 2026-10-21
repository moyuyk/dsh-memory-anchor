#!/usr/bin/env node
/**
 * make-release.mjs —— 从当前工作树导出一份「发布候选」到包外目录
 * =================================================================
 *
 * 为什么要它：源码目录（D:\dsdata\projects\dsh-memory-anchor）是开发态，
 * 半成品、调试脚本都在里面。测试「装上去是什么样」应该在包外的一份干净副本里做。
 *
 * 用法：
 *   node scripts/make-release.mjs                 # 默认输出到 D:\dsdata\release\dsh-memory-anchor
 *   node scripts/make-release.mjs <目标目录>
 *
 * 只复制 package.json 的 files 白名单 + package.json 本身，和 npm pack 的内容一致。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pkgRoot = path.resolve(here, '..')
const pkg = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8'))
const target = path.resolve(process.argv[2] || 'D:/dsdata/release/dsh-memory-anchor')

if (path.resolve(target) === pkgRoot) {
  console.error('目标目录不能是源码目录本身')
  process.exit(1)
}

function copyEntry(rel) {
  const from = path.join(pkgRoot, rel)
  const to = path.join(target, rel)
  const st = fs.statSync(from)
  if (st.isDirectory()) {
    for (const name of fs.readdirSync(from)) {
      if (name === 'node_modules' || name === '.git') continue
      copyEntry(path.join(rel, name))
    }
    return
  }
  fs.mkdirSync(path.dirname(to), { recursive: true })
  fs.copyFileSync(from, to)
}

fs.rmSync(target, { recursive: true, force: true })
fs.mkdirSync(target, { recursive: true })
copyEntry('package.json')
for (const entry of pkg.files) copyEntry(entry)

const files = []
const walk = (dir) => {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name)
    if (fs.statSync(p).isDirectory()) walk(p)
    else files.push(path.relative(target, p))
  }
}
walk(target)
const bytes = files.reduce((n, f) => n + fs.statSync(path.join(target, f)).size, 0)

console.log(`[release] ${pkg.name}@${pkg.version} -> ${target}`)
console.log(`[release] ${files.length} 个文件，${(bytes / 1024).toFixed(1)} KB`)
for (const f of files.sort()) console.log('  ' + f.replace(/\\/g, '/'))