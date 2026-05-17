---
title: "阅读 Mini Code：从 Agent Loop 看 Claude Code 的最小化还原"
description: "通过阅读 Mini Code 这个 Claude Code 的最小化复刻项目，整理 Agent Loop 在 execute、cleanup、compact 三个层面的实现机制。"
pubDate: 2026-05-07
tags:
  - Agent
  - Claude Code
  - 源码阅读
---

阅读前注意，本文为手写+gpt-5.4润色生成。

最近阅读了一个名为 Mini Code 的项目。这个项目可以理解成是对 Claude Code 的一个最小化还原，其中我主要关注的是它有关 Agent Loop 的实现。

这里我分别看了三个部分：第一个是 execute 机制，也就是模型返回内容之后，Agent 如何处理普通文本、thinking、progress 和 tool calls；第二个是 cleanup 机制，也就是一次 turn 结束之后，它如何做收尾、保存会话以及恢复状态；第三个是 compact 机制，也就是上下文变长之后，它如何通过不同层级的压缩策略继续维持 Agent 的可用性。

把这三个部分合起来看，其实 Mini Code 的 Agent Loop 并不是简单地“模型返回什么就直接展示什么”。它更像是一个围绕模型输出、工具调用、消息历史、上下文预算和 UI 状态不断协调的循环系统。这里我按照执行、收尾、压缩这三个方向，把这次阅读体会整理一下。

## 一、execute 机制：一次工具调用的完整流程。

一次典型的工具执行流程大概如下：

```text
模型返回 tool_calls
  -> 先处理这次模型响应自带的附加内容
       -> appendThinkingBlocks(next.thinkingBlocks)
       -> if next.content:
            -> if next.contentKind === 'progress':
                 -> onProgressMessage
                 -> 追加 assistant_progress
                 -> pushContinuationPrompt
            -> else:
                 -> onAssistantMessage
                 -> 追加 assistant

  -> 再处理这一整批 tool calls
       -> 初始化 executedToolResults = []
       -> for each call:
            -> onToolStart
            -> ToolRegistry.execute(...)
                 -> find tool
                 -> zod 校验
                 -> tool.run(...)
                 -> 捕获异常并转成 ToolResult
            -> 标记 sawToolResultThisTurn / toolErrorCount
            -> onToolResult
            -> replaceLargeToolResult
            -> 把当前 call 的执行结果放进 executedToolResults

       -> 整批 calls 都完成之后
            -> applyToolResultBudget
            -> 构造 assistant_tool_call messages
            -> 构造最终 tool_result messages
            -> 一次性追加到 messages

       -> 整批结果写回之后
            -> if 任一 result.awaitUser === true:
                 -> 把问题输出成 assistant
                 -> return messages
            -> else:
                 -> 回到外层 step loop
                 -> 进入下一轮 model.next(...)
```

这里总的来说，整个过程就是模型先返回一个请求，然后 Agent 对这个请求进行分层处理。模型返回的内容不一定只是 tool call，它可能还会带 thinking、progress、普通文本，甚至可能是空响应。所以这里的关键不是“执行工具”这一件事，而是要先判断模型这一次到底返回了什么。

### 1. thinking block

第一种情况是模型返回 thinking block。

这里如果有 thinking 的话，Agent 会将 thinking 的内容单独变成一个 block，然后添加到 messages 里面。这里的 role 名称可以理解成 `assistant_thinking`，它会把 thinking 的内容也写进去。

这个 `assistant_thinking` 可以结合在很多种输出里面，比如它可以放在普通最终文本前面，也可以放在 progress 文本前面，也可以和 tool call 一起出现。具体形式大概如下：

```text
// 普通最终文本
assistant_thinking
assistant

// progress 文本
assistant_thinking
assistant_progress
user continuation prompt

// tool_calls + progress
assistant_thinking
assistant_progress
user continuation prompt
assistant_tool_call
tool_result

// tool_calls + 普通文本
assistant_thinking
assistant
assistant_tool_call
tool_result

// 只有 tool_calls，没有文本
assistant_thinking
assistant_tool_call
tool_result
```

也就是说，thinking 在这里不是一个决定流程结束的东西，而更像是模型本次响应中的附加结构。Agent 会保存它，但是后续到底要不要继续执行，还要看这次响应里面有没有 progress、普通文本或者 tool calls。

### 2. progress 文本

第二种情况是模型返回 progress。

这里 progress 会作为一个标志，说明当前模型不是在给最终答案，而是在告诉用户“我正在继续做”。这时候 Mini Code 会插入一条 continuation prompt，让模型继续往下执行。

这条提示词的角色是 user，内容大概如下：

```text
Continue immediately from your <progress> update with concrete tool calls, code
changes, or an explicit <final> answer only if the task is complete.
```

这里我觉得这个设计比较关键。因为 progress 本身只是一个中间状态，如果没有 continuation prompt，模型可能会停在“我接下来要做什么”的描述上。但是通过追加这条 user prompt，它就把 progress 重新推进成下一步具体动作：要么调用工具，要么改代码，要么给出明确的 final。

### 3. 普通 assistant 文本

第三种情况是模型已经返回普通文本。

如果这次响应没有 tool call，也不是 progress，而是普通 assistant 文本，那它就会被当成一次正常的输出。这里会追加一条 role 为 assistant 的消息，示意这一次请求已经结束。此时 Agent Loop 也就可以结束，用户拿到最终结果。

这里需要注意的是，普通文本才是 Mini Code 判断“一次 turn 正常结束”的主要标志。tool result 本身并不代表结束，因为工具结果只是给模型看的中间结果，后面通常还要再回到模型，让模型基于结果继续判断下一步。

### 4. tool calls

剩余的情况就是执行工具调用，也就是 tool call。

但是这里的工具调用可能会结合若干东西，主要有三种可能性：

1. progress + tool call
2. 普通文本 + tool call
3. 单纯 tool call

当工具执行的时候，上面提到的 progress 或普通文本会先转换成对应的 message block。然后后续执行工具调用的时候，它会分成两个部分：一个是发送请求，也就是包含工具名称、参数等信息的 `assistant_tool_call`；另一个是工具请求的结果，也就是 `tool_result`。最后这些东西会统一拼接到 messages 里面。

这里工具执行本身也不是直接调用函数那么简单。它会先经过 `ToolRegistry.execute(...)`，里面会找 tool、做 zod 参数校验、执行 `tool.run(...)`，同时把异常捕获下来并转成统一的 `ToolResult`。这样不管工具是正常返回还是执行失败，Agent Loop 都能拿到一个结构化结果，而不是让异常直接打断整条链路。

另外，当工具返回内容过大的时候，它会触发 `replaceLargeToolResult`。这里会将较大的工具结果保存成本地的持久化文件，然后把原本的内容替换成文件路径或预览内容。这样既避免了上下文被大输出撑爆，也保留了后续追踪结果的可能性。

### 5. 被截断和空响应

除了上面几种常规情况，还有两种比较特殊的返回处理。

第一种是 thinking 被 `max_tokens` 或 `pause_turn` 截断。

当 content 为空，同时 stop reason 是 `max_tokens` 或 `pause_turn` 的时候，Agent 会判断这是一次可恢复的截断，而不是直接失败。它会追加对应的提示词，说明原因是被 `max_tokens` 或 `pause_turn` 截断，然后继续发送请求。

第二种是模型返回空响应。

如果不是上面这种特殊截断，而是普通的空响应，Agent 也不会立刻停止。它会根据前文是否有工具调用，生成不同的恢复提示。

如果前文没有工具调用，它的提示词大概是：

```text
Your last response was empty. Continue immediately with concrete tool calls, code changes, or an explicit <final> answer only if the task is complete.
```

如果前文有工具调用，它的提示词大概是：

```text
Your last response was empty after recent tool results. Continue immediately by trying the next concrete step, adapting to any tool errors, or giving an explicit <final> answer only if the task is complete.
```

这么做可以有效避免一次空响应就停止。它把空响应视为了一个可恢复的问题，而不是马上把整个 Agent Loop 判定为失败，这一点会明显提高容错。

但同时，如果多次请求都返回空响应，并且已经达到重试上限，那么这里就会返回一个 fallback，同时跳出当前循环。

### 6. awaitUser 的处理

当这一轮中要求调用的所有工具都调用结束后，Agent 会将这些工具的调用过程整理成 messages。

这里还有一个细节：如果检测到某个工具结果里面包含 `awaitUser: true`，它并不会在这个工具一返回的时候就立刻中断。它会先把这一整批工具都执行完，然后在最后把问题输出成 assistant 消息，让用户回答这个问题。

这样做的好处是，批量 tool calls 的执行顺序和记录不会被中间某一个 awaitUser 打断。Agent 仍然可以保持一整批 tool calls 的完整性，然后再把需要用户补充的信息抛出来。

## 二、cleanup 机制：一次 turn 结束之后还要做什么

当 Agent 执行完它的 execute 步骤之后，还会有若干收尾。这里的收尾可以分为两类：一类是位于 loop 之内的，另一类是位于 loop 之外的。

### 1. loop 之内的收尾

当一个 `runAgentTurn` 执行完毕后，会有以下几种情况。

第一种情况是 tool 中包含 `awaitUser`，需要用户回答问题。这里会将 tool 的输出结果提取出来，然后作为一条 assistant 消息插入 messages 中，作为最终输出。同时它也会在 TUI 界面显示出来，让用户回答这个问题。

第二种情况是 tool 中不包含 `awaitUser`。这里并不能算结束，因为 tool 输出不是结束的标志。只有当模型输出单纯的普通文本时，这个 Agent 才会将其判定为 role 是 assistant 的最终输出，并决定这次 turn 结束。

第三种情况就是正常结束。也就是说，当 Agent 输出一个普通文本时，它会生成一条 role 为 assistant 的消息，然后把这条消息插入 messages，作为这一次调用的结束。

第四种情况是空响应重试耗尽后的失败型收尾。按照前面 execute 机制的说明，如果空响应的重试次数达到上限，这里会自动进入 fallback。因为 tool 调用本身一般不会出现空响应这种情况，所以这里的空响应主要存在于普通文本，也就是最后一条 assistant 身份的角色身上。它会在原来的 messages 后面添加一条新的 assistant 消息，消息的大概含义就是返回的响应为空，请重新尝试。

第五种情况是达到最大 step 数时的强制收尾。同理，当一轮请求达到最大 step 上限时，它也会像上面一样，把已有请求打包成一个 messages，然后附加一条 assistant 消息，消息的大概含义就是已经达到了最大的 step 数。

第六种情况是 Context Collapse 状态同步。这里不是传统意义上的收尾，而是当调用了 context collapse 之后，它会产生一个特殊问题：messages 本身发生了变化，但是这个变化不完全是通过 messages 返回出去的。更准确地说，context collapse 本身有一部分是由 state 状态管理的，而这个 state 状态不能直接返回，因为 `runAgentTurn` 最后只能返回 messages。所以这里会在每一次 `runAgentTurn` 的结尾，将这个状态同步到外层。

这里可以看出，loop 内部的收尾主要是在解决一个问题：这一次 turn 到底应该以什么形态结束。它可能是正常 assistant 文本结束，也可能是 awaitUser，可能是 fallback，也可能是 step 上限触发的强制结束。

### 2. loop 之外的收尾

除了 `runAgentTurn` 内部做的事情以外，出了这个函数之后，还需要做几件事。

第一点是权限清除。

这一步的作用是清掉 turn 级别的临时编辑许可状态。例如当前回合内临时放开的编辑权限，不会自动泄漏到下一轮。这个设计是比较重要的，因为权限如果跨 turn 泄漏，就会让后续操作的边界变得不清晰。

第二点是用 `nextMessages` 覆盖当前会话消息。

用更简单的话来说，就是将这一轮生成的 messages 返回过去，然后把当前会话里的 messages 赋值成返回的那一份。这样外层会话状态才会和 `runAgentTurn` 的执行结果保持一致。

第三点是保存会话。

这里的保存会话是指持久化保存，也就是将中途的一些会话保存成 JSON 文件格式。这个保存会话又可以分成几种情况。

首先是正常的新会话。原本没有对应的持久化保存文件时，当这一轮结束，它会新建一个持久化保存文件，将除了原本 system prompt 以外的所有 messages 全部保存到这个 JSON 文件中。

第二种情况是在一个已经存在的会话上继续执行。也就是说之前是有消息的，这时它保存到持久化文件的方式是：将那些原本已经保存过的消息去重，只保留那些新添加的消息。

第三种情况是发生 compact。compact 的本质是将 messages 中的若干消息总结成一条消息。这里它会将这一条总结消息提交上去，而原本被替换的那若干条消息，在持久化文件中同样是保存的。这个总结消息会说明它总结的是从哪一条到哪一条的哪些消息。除此以外，它也会像第二种情况一样，把新的消息追加保存。

第四点是恢复 UI 的非忙碌状态。

Agent 在进入执行状态的时候会开启忙碌模式，结束的时候要把忙碌模式取消，方便用户下一次输入。这个看起来只是 UI 层的小细节，但如果没有这个状态恢复，用户就会感觉系统一直卡在执行中。

第五点是清理 dangling running tools。

在 run agent 返回的过程中，中间执行可能会出现错误。因为前面的函数已经更新了对应的 TUI 状态，如果中间抛出错误，就可能导致某些工具执行过程的 TUI 状态没有被正确更新。这里会把 TUI 状态修正过来，提示用户这个工具失败了，避免界面上残留一个还在运行中的工具。

所以 cleanup 机制本质上是在保证：一次 turn 不管是正常结束、失败结束，还是等待用户输入，都能把消息、权限、会话、UI 和工具状态收拾干净。

## 三、compact 机制：上下文变长之后如何继续运行

Mini Code 的 compact 流程可以分成四层：

```text
snip compact
直接删除安全中段，省 token 明显，保护编辑和错误上下文。

microcompact
清空旧工具输出，成本最低，直接改 messages。

context collapse
调用模型总结旧片段，但只生成 modelMessages，不破坏原始 transcript。

auto/manual compact
调用模型总结整段旧历史，真实替换 messages，保留 system + summary + recent tail。
```

这里我觉得它比较有意思的地方在于，它不是只有一种 compact，而是按照成本和破坏性分层。能不调模型就先不调模型，能不真实改 messages 就先不真实改 messages，只有上下文压力真的比较大时，才进入更强的 compact。

### 1. Token 统计

Token 统计是 compact 机制的基石。下面的几个机制都是建立在 token 统计的基础上去进行的。

只有这个 token 统计能够获取当前上下文大小以及总上下文上限之后，它才能根据占比依次执行各种机制，进而实现分层压缩。

### 2. Snip Compact

Snip Compact 触发于上下文达到上限的 70% 以上的时候。

这个机制不需要调用大模型。它会将最开始的 system prompt 以及最近的 12 条信息保存下来，然后取中间比较安全的一些信息，将这些信息直接替换为占位符。这样的话可以至少减去 2000 token 左右。

这里的关键是“安全中段”。它不是随便删历史，而是尽量保护最近的编辑上下文和错误上下文。因为对于代码 Agent 来说，最近发生的工具调用、错误信息、用户最后的要求，往往比很早之前的中间过程更重要。

### 3. Micro Compact

Micro Compact 的触发条件是上下文达到 50% 以上。

这个机制会处理工具调用中较长的、可重复获取的内容。具体来说，处理的工具会包括 `read_file`、`command`、`search_files`、`list_files`、`web_fetch` 等等。

它会把这些旧工具输出替换成占位符。这里的成本最低，因为它不需要调用模型，也不需要对整段对话做总结。它只是判断某些工具结果已经不值得继续完整留在上下文里，然后把它们清空或折叠。

### 4. Context Collapse

Context Collapse 是基于大模型的，它的触发时机是上下文超过 75% 的时候。它会尝试压缩，尽量将上下文压缩到 65% 左右。

这里需要强调一点：Context Collapse 生成的总结只是传给大模型看的。实际上原始 transcript 里面的内容还是原来的样子。也就是说，它不是直接破坏原始 messages，而是让传给模型的 `modelMessages` 变成折叠后的样子。

它的机制大概是这样的：

1. 不会对最近的 12 条信息进行折叠。
2. 不会对用户最后一个消息之后的所有信息进行折叠。
3. 一次最多只能生成两个 span。
4. 为了避免打断工具调用链路，它会将 tool call 和 tool result 视为一个整体，不会把这两个内容拆开。

这一步我觉得是比较折中的。它既让模型看到更短的上下文，又不直接改掉真实消息历史。这样如果后面需要保存、追踪或者恢复原始 transcript，也不会因为 collapse 而丢掉原文。

### 5. Auto Compact

Auto Compact 也是基于大模型的，它的作用是整体地将上下文 summary 起来。

这里核心函数是 `compactConversation`，它的流程大概是：

1. 计算压缩前 token。
2. 保留 system messages。
3. 确定 retention boundary。
4. 把 boundary 之前的旧消息转成文本。
5. 调模型生成 `<summary>`。
6. 构造 `context_summary` 消息。
7. 返回新的 `messages`。

最后新的 messages 结构大概是：

```text
system messages
context_summary
recent tail messages
```

这里的 retention boundary 是指从尾向前扫描，看看需要保留哪些话。它的原则主要有三条：第一条是至少保留 6 条消息，第二条是最多保留 4 万个 token，第三条是避免将 tool call 和 tool result 拆开。

和 Context Collapse 不同，Auto Compact 会真实替换 messages。也就是说，它不是只改变传给模型的视图，而是把旧历史总结成一条 summary，再加上最近的 tail messages，形成新的会话历史。

### 6. Manual Compact

除了自动 compact 以外，Mini Code 也提供了手动 compact 的方式。

用户可以通过命令主动触发：

```text
/compact -> 对应 Auto Compact
/snip -> 对应 Snip Compact
/collapse -> 对应 Context Collapse
```

这个设计的好处是，compact 不完全由系统自动决定。用户如果明确知道当前上下文太长，或者想要主动清理历史，也可以手动介入。

### 7. Tool Result Storage

Tool Result Storage 其实和 compact 关系也很紧密。

有些工具执行的结果太长，这时 Mini Code 会选择将其变成持久化文件放在本地，然后将 tool result 修改为“对应执行结果保存在哪个路径下”。这样大输出不会直接留在上下文里，但结果本身也没有完全丢失。

这个机制在 execute 阶段也会出现，因为它发生在工具结果写回 messages 之前。也就是说，compact 不只是一个 turn 开始前才做的事情，它也会嵌入到工具执行结果的处理过程中。

### 8. 几种策略对比

| 策略                | 是否调用模型 | 是否真实改 `messages`        | 主要处理对象 | 典型作用               |
| ------------------- | ------------ | ------------------------------ | ------------ | ---------------------- |
| tool result storage | 否           | 改 tool result 内容            | 超大工具输出 | 大输出落盘，保留预览   |
| microcompact        | 否           | 是                             | 旧工具结果   | 清空低价值旧输出       |
| snip compact        | 否           | 是                             | 安全中段历史 | 删除中间历史并插入边界 |
| context collapse    | 是           | 否，主要生成 `modelMessages` | 旧对话片段   | 模型可见视图折叠成摘要 |
| auto compact        | 是           | 是                             | 大段旧历史   | 用 summary 替换旧历史  |
| manual compact      | 是           | 是                             | 大段旧历史   | 用户主动完整压缩       |

### 9. 一次完整示例

假设当前会话已经很长：

```text
system
user: 修复 bug
assistant: 我先读文件
tool_call: read_file
tool_result: 很长的文件内容
assistant: 发现问题
tool_call: edit_file
tool_result: Applied reviewed changes
user: 继续优化
...
recent messages
```

当用户发起下一轮请求时，Agent 会先计算上下文使用率。

如果超过 70%，它会尝试删除安全中段历史，插入 `snip_boundary`。如果超过 50%，它会清空较旧的 `read_file`、`run_command` 等工具输出。如果超过 75%，它会找一段旧对话，让模型生成摘要，并只在 `modelMessages` 中替换为 `context_summary`。

如果上下文仍然 critical 或 blocked，并且这是本 turn 第一个 step，它会执行 Auto Compact，把旧历史真实替换成 summary + recent tail。

之后，它会用最终得到的 `modelMessages` 请求模型。模型如果调用工具，工具结果太大时会落盘，只把预览写回上下文。本轮结束后，TUI 和 session 还会保存 compact 相关事件。

## 四、整体体会

把 execute、cleanup 和 compact 三个部分合起来看，我对 Mini Code 的 Agent Loop 有一个更完整的理解。

它不是一个简单的 while loop，也不是模型返回 tool call 后直接执行工具这么简单。它真正做的事情是维护一个长期运行的、可恢复的 Agent 状态机。

在 execute 阶段，它要处理模型响应的各种形态：thinking、progress、assistant 文本、tool calls、空响应、截断响应，以及 awaitUser。这里每一种形态都会被转换成明确的 message 结构，然后继续进入下一步。

在 cleanup 阶段，它要保证一次 turn 不管如何结束，都能把状态收回来。消息要更新，会话要保存，权限要清理，UI 要恢复，工具状态也不能残留在 running 状态。

在 compact 阶段，它要解决长期上下文的问题。这里的设计不是一次性粗暴总结，而是分成 tool result storage、microcompact、snip compact、context collapse、auto compact/manual compact 等多个层级。它会根据 token 使用率，从低成本、低破坏性的策略开始，逐步进入更强的压缩。

这里我觉得最值得学习的是两点。

第一点是 Mini Code 对“异常情况”的处理比较细。空响应不会马上失败，截断会继续请求，工具异常会变成 ToolResult，awaitUser 会等整批工具结束后再统一处理。这些设计都让 Agent Loop 不容易因为一次模型或工具的小问题就断掉。

第二点是它对上下文的处理比较克制。它不会一开始就调用模型总结所有历史，而是先清理工具结果、删除安全中段，再根据需要做 collapse 或 compact。这里的本质是把上下文当成一种预算来管理，而不是等到彻底爆掉之后再补救。

所以从这个项目里可以看到，一个能实际工作的代码 Agent，重点不只是 prompt 或 tool 本身。更重要的是围绕它们的一整套循环机制：如何推进模型继续行动，如何把工具结果写回上下文，如何在失败时恢复，如何在 turn 结束后收尾，以及如何在上下文越来越长的时候仍然维持可用性。

这也是我读 Mini Code 的最大体会：Agent Loop 的核心并不神秘，但要把它做得稳定，需要在很多细节上持续兜底。
