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
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pkgRoot = path.resolve(here, '..')
const pkg = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8'))
const args = process.argv.slice(2)
const dirArg = args.find((a) => !a.startsWith('-'))
const target = path.resolve(dirArg || 'D:/dsdata/release/dsh-memory-anchor')
const wantTgz = args.includes('--tgz')

if (path.resolve(target) === pkgRoot || target.startsWith(pkgRoot + path.sep)) {
  console.error('目标目录不能是源码目录本身或它的子目录')
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

if (process.argv.includes('--tgz')) {
  const tgz = path.join(path.dirname(target), `${pkg.name}-${pkg.version}.tgz`)
  execFileSync('tar', ['-czf', tgz, '-C', path.dirname(target), path.basename(target)], { stdio: 'inherit' })
  console.log(`[release] tarball ${tgz}`)
}