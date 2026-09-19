---
name: html-to-android-app
description: Wrap a static HTML/CSS/JS page or web build into an installable Android APK with Capacitor, optionally via GitHub Actions. Use for 封装网页/HTML 为 APP、套安卓壳、打包 APK or system local notifications. Not for native-code apps or iOS.
---

# 网页封装为 Android APP（Capacitor）

把纯静态网页（index.html + css/js）或前端构建产物封装成可安装的 Android APK。
零 Android Studio；本地出包或 GitHub Actions 云端出包二选一（新手推荐云端）。

## 0. 先确认四件事

1. **网页入口与资源清单**：默认 `index.html / style.css / app.js`；若有构建步骤则是 `dist/`、`build/` 之类产物目录。
2. **appId**：反向域名且全小写、至少两段（如 `com.example.myapp`），发布后不可更改。
3. **appName**：桌面图标下显示的名称。
4. **需要哪些原生能力**：本地通知、文件导出/分享、返回键；以及出包方式（本地 / CI）。

## 1. 安装依赖（Node 18+）

本地出 APK 才需要 JDK 17 与 Android SDK；只走 CI 则本机有 Node 即可。

```powershell
npm init -y
npm install @capacitor/core@^6 @capacitor/android@^6
npm install -D @capacitor/cli@^6
# 按需要安装插件：
npm install @capacitor/local-notifications@^6 @capacitor/app@^6 @capacitor/filesystem@^6 @capacitor/share@^6
```

## 2. 配置与 webDir —— 保持单一事实来源

源网页文件**保持在原位置不动**（浏览器双击仍可用），用拷贝脚本同步到 Capacitor 的 `webDir`，避免两处维护：

- 复制 `assets/capacitor.config.json` 到项目根，改 `appId / appName`（构建产物项目把 `webDir` 改成 `dist` 等即可，无需拷贝脚本）。
- 复制 `assets/copy-web.mjs` 到 `tools/copy-web.mjs`，按实际资源改 `ENTRIES` 清单（文件和目录都支持）。
- package.json 增加脚本：

```json
{
  "scripts": {
    "copy-web": "node tools/copy-web.mjs",
    "build": "npm run copy-web",
    "sync": "npm run build && cap sync android",
    "apk": "npm run build && cap sync android && cd android && gradlew.bat assembleDebug"
  }
}
```

`webDir` 在执行 `cap sync` 前必须已生成（先跑一次 `npm run build`）。

## 3. 添加并同步 Android 平台

```powershell
npx cap add android        # 仅首次，生成 android/ 工程
npm run sync               # 每次改完网页/插件后执行
```

验证 `android/app/src/main/assets/public/` 下已有 `index.html`。Capacitor 6 对应 compileSdk 34、minSdk 22（见 `android/variables.gradle`）。

## 4. 名称、图标、启动页

- 应用名：`android/app/src/main/res/values/strings.xml` 的 `app_name`。
- 图标：替换各 `mipmap-*/ic_launcher.png`（同时换 foreground/round）。
- 启动页：替换各 `drawable*/splash.png`。

## 5. 权限与系统级本地通知（按需）

**Manifest**：把 `assets/AndroidManifest.permissions.xml` 中的权限合并进
`android/app/src/main/AndroidManifest.xml` 的 `<manifest>` 内。
作用：INTERNET、Android 13+ 通知、Android 12+ 精确闹钟（杀进程后到点能弹）、开机后重注册、电池优化白名单引导。

**JS 侧**：用 `window.Capacitor.isNativePlatform()` 做特性检测，浏览器环境安全回退；
注册插件 → 建渠道（Android 8+ 必须，importance 5 才有弹窗+声音+震动）→ 申请权限 → 排期：

```js
function isNative() {
  return !!(window.Capacitor &&
    typeof window.Capacitor.isNativePlatform === 'function' &&
    window.Capacitor.isNativePlatform());
}

const P = isNative() ? window.Capacitor.registerPlugin('LocalNotifications') : null;

await P.createChannel({
  id: 'app-notify', name: '提醒',
  description: '到点提醒', importance: 5, visibility: 1,
  vibration: true, lights: true
});

const { display } = await P.requestPermissions();
if (display === 'granted') {
  await P.schedule({
    notifications: [{
      id: 1,                       // 稳定整数 id；同 id 重排即覆盖旧通知
      title: '⏰ 提醒',
      body: '内容',
      channelId: 'app-notify',
      schedule: { at: new Date(timestamp) }
    }]
  });
}
```

关键策略（缺一会漏通知）：

- **全量重排**：数据变化时先 `getPending()` → `cancel()` 全部，再按当前数据注册未来时刻项。
- **启动/回前台重注册**：监听 `resume`、`visibilitychange`，开机后通知不保留，App 启动时必须重新 schedule。
- **国产 ROM**：权限授予后引导用户允许后台运行/自启动、关闭电池优化（小米/华为/OPPO/vivo 等默认杀后台）。
- 返回键用 `registerPlugin('App')` 的 `backButton` 事件自定义层级（弹层 → 页面 → 退出）。
- 数据备份/导出可用 Filesystem + Share 插件写 JSON 文件分享。

## 6. 本地出 APK

```powershell
npm run apk
# 产物：android/app/build/outputs/apk/debug/app-debug.apk
adb install -r android\app\build\outputs\apk\debug\app-debug.apk
```

手机需允许"未知来源安装"。

## 7. GitHub Actions 云端出包（推荐，免本地 SDK）

复制 `assets/android.yml` 到 `.github/workflows/android.yml`，按实际网页文件名调整 `paths` 触发过滤。
流程要点（两个坑已在模板内处理，改动时不要回退）：

1. **不要用 setup-android action**：它依赖的旧版 `tools` 包已被 Google 移除，`sdkmanager` 直接退出码 1。
   用 runner 预装的 `cmdline-tools/latest/bin/sdkmanager` 显式安装
   `platform-tools`、`platforms;android-34`、`build-tools;34.0.0`。
2. 工具链：Node 20（`cache: npm`）+ JDK 17（temurin）；`npm ci` → `npm run build`
   → `npx cap sync android` → `./gradlew assembleDebug` → `actions/upload-artifact@v4`。
3. 仓库必须提交 `package-lock.json`，否则 `npm ci` 失败（无 lock 文件时改用 `npm install`）。

push 到 main 后在 Actions 运行页的 Artifacts 下载 APK（保留 30 天）；`workflow_dispatch` 支持手动触发。

## 8. Windows 提交必做：gradlew 可执行位

Windows 上 git 提交会丢失 `gradlew` 的可执行权限，Linux CI 报 Permission denied：

```powershell
git update-index --chmod=+x android/gradlew
git ls-files -s android/gradlew    # 确认模式为 100755
```

然后正常 commit、push。

## 9. 验收清单

- 改动网页先用本地静态服务器验证（`npx serve .` 或 `python -m http.server`），确认无 JS 报错再封壳。
- CI 变绿且下载到的 artifact 是有效 APK；装机后检查：图标/名称正确、网页功能正常、返回键行为正确。
- 通知实测：到点弹出；**杀掉 App** 后到点仍弹；**重启手机**后打开 App 通知恢复。
- 数据：localStorage 存在 WebView 中，卸载即丢失 —— 网页应提供 JSON 导出/导入备份入口。

## 新手注意事项

- 每次改完网页必须 `npm run build` + `npx cap sync android`，APK 才会包含新内容（CI 自动完成）。
- WebView 默认禁止明文 HTTP，远程 API 一律用 HTTPS。
- 发版改版本号：`android/app/build.gradle` 的 `versionCode`（整数递增）和 `versionName`。
- 本流程产出的是 debug APK，可自用/内测；上架应用商店需要签名 release 包，不在本 skill 范围。
