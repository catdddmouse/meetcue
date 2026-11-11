'use strict';
// 构建 MeetCue.app：Electron 运行时 + 应用代码 + OCR 助手 + 图标，本机临时签名。
// 用法：node build.cjs [输出路径，默认 dist/MeetCue.app]
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const root = __dirname;
const target = path.resolve(process.argv[2] || path.join(root, 'dist/MeetCue.app'));
const src = path.join(root, 'node_modules/electron/dist/Electron.app');
if (!fs.existsSync(src)) throw Error('先运行 npm install 安装 Electron');
const pb = (plist, c) => cp.execFileSync('/usr/libexec/PlistBuddy', ['-c', c, plist]);
const set = (plist, key, type, value) => { try { pb(plist, `Set :${key} ${value}`); } catch { pb(plist, `Add :${key} ${type} ${value}`); } };

fs.mkdirSync(path.join(root, 'build'), { recursive: true });
cp.execFileSync('swiftc', ['-O', path.join(root, 'ocr-helper/main.swift'), '-o', path.join(root, 'build/prompter-ocr')], { stdio: 'inherit' });
fs.rmSync(target, { recursive: true, force: true });
fs.mkdirSync(path.dirname(target), { recursive: true });
cp.execFileSync('/bin/cp', ['-R', src, target]);
const res = path.join(target, 'Contents/Resources');
fs.rmSync(path.join(res, 'default_app.asar'), { force: true });
const appDir = path.join(res, 'app');
fs.mkdirSync(appDir);
fs.cpSync(path.join(root, 'src'), path.join(appDir, 'src'), { recursive: true });
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify({ name: pkg.name, productName: 'MeetCue', version: pkg.version, main: 'src/main.cjs' }));
fs.copyFileSync(path.join(root, 'build/prompter-ocr'), path.join(res, 'prompter-ocr'));
fs.copyFileSync(path.join(root, 'brand/MeetCue.icns'), path.join(res, 'electron.icns'));
const plist = path.join(target, 'Contents/Info.plist');
set(plist, 'CFBundleIdentifier', 'string', 'app.meetcue.desktop');
set(plist, 'CFBundleDisplayName', 'string', 'MeetCue');
set(plist, 'CFBundleShortVersionString', 'string', pkg.version);
set(plist, 'LSUIElement', 'bool', 'true');
set(plist, 'NSScreenCaptureUsageDescription', 'string', 'MeetCue reads caption text from your meeting window.');
cp.execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', target], { stdio: 'inherit' });
console.log('Built: ' + target);
