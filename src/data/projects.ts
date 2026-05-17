export type Project = {
  title: string;
  description: string;
  sections: Array<{
    heading: string;
    items: string[];
  }>;
};

export const projects: Project[] = [
  {
    title: "多智能体图像编辑系统",
    description: "面向多图输入、复杂自然语言指令与异构视觉工具协同的图像编辑系统。",
    sections: [
      {
        heading: "系统设计",
        items: [
          "组织运行时状态图，将任务拆分为 register_and_understand、plan、execute_current_task 与 evaluate_checkpoint 等节点。",
          "设计 Plan、Execute、Evaluator 三类智能体：PlanAgent 负责初始规划与失败后的重规划；ExecuteAgent 以 thinking-act-observe 循环执行当前子任务；EvaluatorAgent 对候选结果进行检查，并决定通过、继续执行、局部重试、全局重规划或失败退出。",
          "引入任务级状态管理，维护 artifacts、working set、task states 与 plan history，使复杂编辑链路可以保留已通过的中间结果，并在失败时只重做必要步骤。",
        ],
      },
      {
        heading: "工具与后端",
        items: [
          "通过 ToolRegistry 管理图像理解、grounding、segment、crop、collage、prompt reconstruction、edit 与 evaluate 等工具，执行智能体根据当前任务状态动态选择工具。",
          "抽象编辑与分割后端接口，方便接入不同图像编辑模型和分割模型；后端可通过远程 HTTP 服务运行，主进程只传递 JSON 请求和共享文件路径，降低模型加载、显存占用与主流程调度之间的耦合。",
          "支持多图输入和复杂自然语言指令，执行阶段会控制编辑输入数量，并在工具调用错误、输入超限或候选结果不满足要求时触发重试或重规划。",
        ],
      },
      {
        heading: "运行与可观测性",
        items: [
          "生成结果统一写入 generated/ 目录，包括编辑候选图、分割 mask、评估材料和服务日志。",
          "从 harness engineering 角度构建可复现的任务运行与评测框架，统一管理输入样例、工具调用轨迹、候选结果、评估结论与失败原因。",
          "运行过程沉淀结构化 artifacts、operations 与 JSONL agent logs，支持失败重试、局部继续、结果回放、跨后端对比和全局重规划，便于复现实验、定位失败步骤和做回归测试。",
          "后端适配层同时保留远程服务模式与本地模式，便于在部署、开发和 fallback 测试之间切换。",
        ],
      },
    ],
  },
];
