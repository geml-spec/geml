# geml-history 使用指南

> **状态** stable · **声明** 在 `.gemlhistory` 的 `=== meta` 里写 `profile = "geml-history/v1"`（`geml history save` 会自动写上）· **限制** 历史是线性的，不分支，也不合并

## 它做什么

把文档的旧版本存进旁边一个纯文本伴生文件：`notes.geml` 旁边会多出 `notes.gemlhistory`。
可以查看任意旧版本，只回退某一个块，或者把整个文件回滚，不需要 git，也不需要服务器。

## 上手

先装好 CLI：`npm i -g @geml/geml`（Node 22+）。随便拿一个 `.geml` 文件，这里用 `notes.geml`：

```geml
# 笔记

## 计划 {#plan}

周五发布。

## 预算 {#budget}

预算 10k。
```

先存一条修订；在编辑器里把 `10k` 改成 `25k`，再存一条，然后列出所有修订：

```console
$ geml history save notes.geml -m "初稿"
saved 20261001T040113Z-33872949
$ geml history save notes.geml -m "提高预算"
saved 20261001T040115Z-c3bd0b72
$ geml history get notes.geml
0       20261001T040115Z-c3bd0b72  -  提高预算
-1      20261001T040113Z-33872949  -  初稿
```

第一列是其他命令里指定修订用的编号：`0` 是最近一次保存，`-1` 是它的前一次。
文件没改过时再存，不会新增修订。

## 常用

查看某条旧修订的全文：

```sh
geml history get notes.geml -1
```

只回退一个块，文件其余部分原样不动。回退后不会自动保存，要留下就再跑一次 `geml history save`：

```console
$ geml revert notes.geml '#budget'
reverted #budget to 20261001T040113Z-33872949
```

默认退到上一条修订。加 `--rev changed` 则退到这个块自己的上一个版本，哪怕之后别的块又存过；
agent 改过一个块之后，用它回退更稳妥。

把整个文件回滚到某条修订。比它新的修订会全部删掉（见参考文档 §7）。
文件有未保存的改动时，它会拒绝执行：先保存，或者加 `--force` 放弃这些改动。

```sh
geml history restore notes.geml -1
```

用 `geml mcp` 的 agent 也一样：每次写入前都会先存一条修订，所以 `geml_revert` 可以只回退一个块。
`.gemlhistory` 交给工具来写，原因见参考文档 §10。

**延伸：** [参考文档](geml-history-profile_CN.md) · [图解](https://geml-spec.github.io/illustrated/08-profile-history_CN.html)
