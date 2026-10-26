---
name: baidu-devops
description: 百度研发工具链速查（icode 代码提交全流程、icafe 卡片/任务、ipipe 流水线）。当任务涉及拉代码库、发 CR、打分合入、查建卡片、触发流水线、查构建状态时使用。均通过 console.cloud.baidu-int.com 的研发工具集提供。
---

# 百度研发工具链（icode / icafe / ipipe）

## icode —— 代码提交全流程

代码库克隆、CR 提交与追加、添加评审人、机器检查修复、打分与合入（从绑定卡片 → 提交 → 合入完整链路）。

典型用途：
- 拉取 `infer-forge-harness` / `aiak_sglang` / `attentionstore/sdk` / `attentionstore/agent` 等代码库。
- 发起 CR、追加评审人、触发机器检查修复。

入口：`https://console.cloud.baidu-int.com/devops/icode`

## icafe —— 卡片 / 任务

查询、创建、更新 iCafe 卡片（Story/Bug/Task/Epic）、评论、流程状态、操作历史、迭代计划（Plan）、里程碑（Milestone）、IQL 查询。

典型用途：
- 为推理优化任务建卡片、查状态、追加评论/进展。

入口：`https://console.cloud.baidu-int.com/devops/icafe/workspace`

## ipipe —— 流水线

流水线配置查询、触发构建（按 commitId/changeId 或分支）、构建状态/阶段/任务/日志查询、取消任务/重跑阶段。

典型用途：
- 代码提交后触发编译部署流水线，查构建状态与日志链接。

入口：`https://console.cloud.baidu-int.com/devops/ipipe`

## 注意

- 三者在 Pi 中作为平台能力使用：优先通过对应研发工具集的 API/CLI 调用，具体接口以各工具集官方文档为准。
- 涉及周报与 OKR 的诉求不要路由到 icafe；纯代码提交流程用 icode 而非 icafe。
