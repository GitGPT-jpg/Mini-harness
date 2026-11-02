# 扫描 90403202 修复记录

基线：`97a25c56e33a357f7a0515850fa13a00403a8894`。报告返回 10,000 条，
涉及 40 个 CSS、11 个 JavaScript 文件。本记录只对收到的报告负责，不推断服务端是否截断了更多问题。
这些条目主要是编码规范问题，不代表发现了 9,997 个安全漏洞。

| 范围 | 原报告 | 已修复 | 保留并说明 |
| --- | ---: | ---: | ---: |
| CSS 格式 | 8,863 ERROR | 8,863 | 0 |
| CSS 重复选择器／属性 | 5 ERROR | 5 | 0 |
| 现代 CSS 误报 | 7 ERROR | 0 | 7 |
| JavaScript | 1,122 ERROR、3 WARNING | 1,125 | 0 |
| 合计 | 10,000 | 9,993 | 7 |

修复统计接口按 ERROR 口径上报：`bug-num=9997`、`repair-num=9990`。
报告 SHA-256：`93a40c89111fdee6517d24d27164a281c8433a105481e1325f855d088a851781`。

## 格式与重复项

| 规则 | 原命中数 | 修复 |
| --- | ---: | --- |
| CSS1050 | 8,149 | 四空格缩进 |
| CSS1018 | 619 | 规则之间空行 |
| CSS1088 | 61 | 等价的短十六进制颜色 |
| CSS1020 | 17 | 多行值列表的逗号后换行 |
| CSS1003 | 11 | 后代选择器间使用空格 |
| CSS1045 | 4 | 组合器前空格 |
| CSS1055、CSS1067 | 各 1 | 注释空格、自定义属性空行 |
| CSS1004 | 4 | 删除已被覆盖的规则，保留最终级联位置 |
| CSS1005 | 1 | 删除已被后续声明覆盖的 `border: none` |
| JS1002 | 1,043 | 报告位置使用单引号 |
| JS1008 | 70 | 控制语句补花括号 |
| JS1079 | 9 | 长行折行，保持字符串值 |
| JS1067 | 1 WARNING | 提取缓存失败回调，保持 Promise 链 |
| JS1061 | 1 WARNING | 合并 `node:url` 导入 |
| JS1034 | 1 WARNING | `while (true)` 改为 `for (;;)`，保留退出条件 |

重复项的原报告位置与处理：

- `web/src/styles.css:6610`：合并 `.ctx-menu`，把早期块唯一未被覆盖的
  `font-size: 13px` 保留在后块，其余最终声明不移动。
- `web/src/styles.css:12354`：保留 `.goalbar-hint` 最终虚线边框。
- `themes/bases/obsidian-base.css:852`、`:866`：删除完全被后方相同选择器覆盖的白色／阴影声明，
  保留后方继承颜色和取消阴影的规则。
- `themes/md-preview.css:108`：合并相邻 `:root`，保留最终背景 `#0a0b10`。

JavaScript 修复覆盖：

| 文件 | 报告条数 |
| --- | ---: |
| `web/public/sw.js` | 20 |
| `scripts/release-notes.mjs` | 33 |
| `make-light-theme.mjs` | 577 |
| `scripts/screenshot-themes-preview.mjs` | 15 |
| `scripts/zh-tw-locale/build-pack.mjs` | 6 |
| `scripts/sync-locales.mjs` | 52 |
| `scripts/zh-tw-locale/glossary.mjs` | 50 |
| `bin/pi-web-ui.mjs` | 226 |
| `scripts/i18n-diff.mjs` | 118 |
| `scripts/zh-tw-locale/verify.mjs` | 13 |
| `scripts/check-protocol-sync.mjs` | 15 |

## 7 个保留的误报

行号为原报告行号。

| 文件／位置 | 规则 | 保留理由 |
| --- | --- | --- |
| `web/src/styles.css:13` | CSS1008 | `@layer base` 是标准层叠层，不能删掉层环境 |
| `web/src/styles.css:7665` | CSS1048 | `container-type: inline-size` 是标准容器查询属性 |
| `web/src/styles.css:17870` | CSS1048 | `accent-color` 用于复选框强调色 |
| `web/src/model-management.css:238` | CSS1048 | 同上，用于模型候选复选框 |
| `web/src/styles.css:8054` | CSS1069 | `::highlight()` 是 Custom Highlight API 标准伪元素 |
| `web/src/styles.css:8054` | CSS1075 | `msg-search-active` 是高亮名称参数；`SearchBar.tsx` 实际注册了此名称 |
| `web/src/styles.css:24729` | CSS1001 | `foreignObject` 是 SVG 元素的正确大小写 |

使用项目浏览器实测：层叠层、容器类型、强调色和高亮选择器均受支持；
SVG 创建出的元素名为 `foreignObject`。没有为消除这些告警而改写有效语法或关闭远端规则。
远端需要更新检查器或针对这些位置确认误报，尚未执行豁免操作。

参考：[层叠层](https://developer.mozilla.org/en-US/docs/Web/CSS/@layer)、
[容器类型](https://developer.mozilla.org/en-US/docs/Web/CSS/container-type)、
[强调色](https://developer.mozilla.org/en-US/docs/Web/CSS/accent-color)、
[高亮伪元素](https://developer.mozilla.org/en-US/docs/Web/CSS/::highlight)、
[SVG foreignObject](https://developer.mozilla.org/en-US/docs/Web/SVG/Element/foreignObject)。

## 验证与限制

- 8,863 个原 CSS 格式命中逐文件、原行号复现；修改后对应格式规则为零。
- CSS 批量格式化进行了有序 AST 等价检查；5 个重复项另行核对层叠关系。
- 11 个 JavaScript 文件语法检查及归一化 AST 比对通过。
- 35 个主题固定页面截图的前后像素差异全部为 0。
- 菜单、状态栏、目标提示条在三种样式环境下共 450 项计算样式前后一致。
- 类型检查、项目 oxlint、前后端生产构建、协议 v37、12 个语言包及 CLI 版本检查通过。
- 三个测试文件的解析器已支持短 hex 和等价选择器空白；保留原对比度门槛和布局断言。
  全量复验：313 个测试文件通过，3,358 项通过、9 项跳过；类型检查和 oxlint 同时通过。
- 主题生成器同步避免重新输出重复 `:root`，在对比度计算后应用最终背景覆盖，
  并输出四空格缩进、短 hex 和规则空行。隔离生成前后 20 套主题的有效值一致，
  未覆盖实际主题文件。

本轮没有对报告外命中做全仓迁移：本地 CSS 检查另检出 26 条报告外告警，
这些 JavaScript 文件也存在报告外的同类格式命中。因此本记录不声称远端检查已全绿，
也不声称所有 JavaScript 文件通过全文件 Prettier 检查。

相关文件已设置 CSS 四空格、JavaScript 单引号的 Prettier overrides。
六个 CSS 文件的列表／长选择器换行与 iCode 规则存在已复现的 Prettier 冲突，
因此仅从 Prettier 排除这些文件，保留 iCode 规范检查；避免日后格式化重新引入已修问题。
未修改项目依赖、版本号、发行标签或默认分支。

生成器原本就不是当前主题的完整复刻，例如 `md-preview` 的一些状态栏规则和浅色主题的
部分 `color-mix()` 令牌没有被生成器收录。本轮只修复上述防回退问题，未扩大重构或重生成实际主题。
