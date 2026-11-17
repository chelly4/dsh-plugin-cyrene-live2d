# 世界书数据来源

`data/` 下的五份 md（`_glossary.md` / `Cyrene.md` / `world.md` / `characters.md` / `story.md`，
共 61 条）不是本项目原创，来源如下：

- 原始整理：[Cyrene-Agent](https://github.com/Playa-Cyrene/Cyrene-Agent)
  —— MIT License, Copyright (c) 2026 Playa
- 转手仓库：[Cyrene-xl/DSH-Cyrene](https://github.com/Cyrene-xl/DSH-Cyrene) 的 `worldbook/data/`

条目格式（`- 触发词:` / `- 常驻:` / `- 内在价值:` / `- 优先级:` / `- 连带触发词:`）
沿用上游定义，未做改动；正文一字未改。

**角色 IP 声明**：昔涟 /《崩坏：星穹铁道》相关角色与世界观的著作权归
HoYoverse / 米哈游所有，不在上述 MIT 授权范围内。本目录仅限本机个人使用，
不得商用或再分发。

`lib/worldbook.js` 里的解析与匹配代码是本项目自己写的（没有打包上游的
`parse.mjs` / `match.mjs` / `assemble.mjs`），只读取本目录的数据。
