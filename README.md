# 歌词封面抓取助手 (Lyrics & Cover Helper)

[![Songloft Plugin](https://img.shields.co/badge/Platform-Songloft-blue?style=flat-square)](https://github.com/birdstudy-nj)
[![License](https://img.shields.co/badge/License-MIT-green.svg?style=flat-square)](LICENSE)

基于 **Songloft** 打造的底层音乐元数据刮削插件。本插件专为对音乐品质有极致追求的极客设计，智能聚合了 Apple Music、网易云音乐、Lrc.cx 及 Lrclib 等多路权威数据源，为您打造丝滑、精准、高清的歌词与封面全自动匹配体验。

完美适配主流自建音乐客户端 —— **音流 (Yinliu)** 与 **箭头音乐 (Jiantou Music)**。

---

## ✨ 功能特性

* 🖼️ **高清封面刮削引擎**
  * 优先检索 **Apple Music (iTunes API)**，自动提取并解析 `600x600bb` 的原生超清封面。
  * 内置 **网易云音乐 (PC CloudSearch)** 智能兜底机制，多重保障封面的命中率。
  * 完美适配音流客户端的 `302 重定向` 机制与箭头音乐的 JSON 载荷返回。

* 🎤 **多指标歌词评分过滤**
  * 接入 **lrc.cx** 独家歌词打分系统，针对歌曲名相似度、歌手匹配度进行精准权重计算，自动过滤 Live、Remix、DJ、伴奏等杂质版本。
  * 支持**文件名智能拆分**（如 `歌手 - 歌名`），对无标签媒体文件具有极强的包容性。
  * 整合 **Lrclib 终极搜索**，确保冷门与独立音乐依然拥有高品质同步双语/滚动歌词。

* 📡 **可视化监控控制台 (Debug Panel)**
  * 提供优雅的 Web 控制台界面，直观管理接口配置与一键复制 Token 信息。
  * 实时监控外部 App 请求，滚动保留**最近 10 条**核心接入日志，包含请求时间、完整 URL 请求参数以及完整的后端实际返回值（支持长文本自动截断展示）。
  * 针对小屏幕/手机端提供**深度响应式布局优化**，操作按钮在移动端平分宽度，方便单手调试。

* 🍏 **iPhone 端专项兼容优化**
  * 针对 iOS / Safari 浏览器极为严苛的 `CORS 跨域安全策略`（Fetch 拦截 302 外部图片重定向时会触发 `Load failed`）进行了**前端“回马枪”机制优化**。
  * 手机端测试时，若发生重定向拦截，前端会自动安全降级并直连内部 Debug 日志接口读取存盘文本，让 iPhone 网页端测试与原生「音流 App」使用同样丝滑。

---

## 🚀 客户端配置指南

成功在 Songloft 部署本插件后，进入管理面板获取你的专属接口：

### 1. 音流 (Yinliu) 配置
* **路径**：`设置` ➔ `自定义API`
* **配置项**：
  * **验证信息 (Authorization)**：直接复制面板生成的 `Bearer <Your_Token>`
  * **歌词接口**：`http://<Your_Server>:<Port>/api/v1/jsplugin/lyrics-cover-helper/api/yinliu/lyric`
  * **封面接口**：`http://<Your_Server>:<Port>/api/v1/jsplugin/lyrics-cover-helper/api/yinliu/cover` *(返回 301/302 重定向)*

### 2. 箭头音乐 (Jiantou Music) 配置
* **路径**：`设置` ➔ `歌词` ➔ `歌词接口` ➔ `右上角添加`
* **配置项**：
  * **服务名称**：歌词封面助手
  * **服务地址**：`http://<Your_Server>:<Port>/api/v1/jsplugin/lyrics-cover-helper/api/jiantou/lyric?title={title}&artist={artist}`
  * **认证信息**：`Authorization: Bearer <Your_Token>`

---

