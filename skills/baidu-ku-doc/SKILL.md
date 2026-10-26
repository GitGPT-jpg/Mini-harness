---
name: baidu-ku-doc
description: 如流知识库（ku.baidu-int.com）文档与数据表读写工具。通过 ku CLI 实现文档正文读取、增删改查、权限、评论、在线表格导入导出、数据表字段/记录/视图管理。用户提到 ku/知识库/wiki/文档/表格/数据表或提供 ku.baidu-int.com 链接时使用。
---

# 如流知识库（ku.baidu-int.com）工具

通过 `ku` CLI 操作知识库文档与数据表。CLI 位置：

```bash
KU="$HOME/.comate/skills/ku-doc-manage/bin/ku"   # 找不到时用 find ~/.comate/skills -name ku 定位
```

## URL 解析

知识库 URL `https://ku.baidu-int.com/knowledge/{path1}/{path2}/{path3}/{path4}`：
- 4 段 path → 文档页：`{path4}` 是 doc-id，`{path3}` 是 repo-id。
- 数据表 URL 含 `tb=` 且 `type=dst`：`tb` 参数 `{dist-id}_{view-id}`，下划线前是数据表 ID。

## 常用命令

```bash
# 读文档正文（markdown）
"$KU" query-content --url "<URL>" --protocol markdown

# 查文档列表 / 目录树
"$KU" query-repo --repo-id "<repo-id>"
"$KU" query-repo-dir --repo-id "<repo-id>"

# 创建文档（追加 Markdown 后必须 publish）
"$KU" create-doc --repo-id "<repo-id>" --title "标题" --content "正文"
"$KU" edit-mdsl-content --doc-id "<doc-id>" --username "$SANDBOX_USERNAME" --operation '{"mode":"append","markdown":"..."}'
"$KU" publish-doc --doc-id "<doc-id>" --username "$SANDBOX_USERNAME"

# 在线表格导入导出
"$KU" export-sheet --url "<URL>"
"$KU" import-sheet --repo-id "<repo-id>" --file "<xlsx>" --title "表格名"

# 数据表记录
"$KU" get-datasheet-records --dist-id "<dist-id>"
```

## 注意

- 必须设置 `SANDBOX_USERNAME`（或 `BAIDU_CC_USERNAME`）确定用户身份与 token 路径。
- `markdown` 内容含单引号/换行时需做 JSON 转义，或用 `--md-file` 从文件读取。
- 正文编辑是「编辑 + 发布」两步：`edit-mdsl-content` 成功后必须 `publish-doc`，否则读者不可见。
- 布尔标志传值用等号形式（如 `--show-resource-info=true`），避免参数被静默丢弃。
