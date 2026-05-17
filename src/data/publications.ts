export type Publication = {
  title: string;
  authors: string;
  venue: string;
  year: string;
  url: string;
  note: string;
};

export const publications: Publication[] = [
  {
    title: "Beyond Empathy: Integrating Diagnostic and Therapeutic Reasoning with Large Language Models for Mental Health Counseling",
    authors: "He Hu, Yucheng Zhou, Juzheng Si, Qianning Wang, Hengheng Zhang, Fuji Ren, Fei Ma, Laizhong Cui, Qi Tian",
    venue: "arXiv",
    year: "2025",
    url: "https://arxiv.org/abs/2505.15715",
    note: "第三作者，负责模型微调与性能评估",
  },
  {
    title: "MindDialog: A large-scale benchmark for counseling dialogue understanding and generation",
    authors: "He Hu, Juzheng Si, Qianning Wang, Tengjin Weng, Yihong Ji, Jiyue Jiang, Fei Ma, Yucheng Zhou, Laizhong Cui, Qi Tian",
    venue: "Pattern Recognition",
    year: "2026",
    url: "https://www.sciencedirect.com/science/article/pii/S0031320326007314",
    note: "第二作者，构建覆盖多样化干预策略结构的大规模真实情境心理咨询对话基准，已接收",
  },
  {
    title: "From Pattern Recognizers to Personalized Companions: A Survey of Large Language Models in Mental Health",
    authors:
      "He Hu, Yucheng Zhou, Qianning Wang, Yingjian Zou, Chiyuan Ma, Juzheng Si, Jianzhuang Liu, Zitong Yu, Laizhong Cui, Fei Ma, Qi Tian",
    venue: "IEEE Transactions on Affective Computing",
    year: "2026",
    url: "https://doi.org/10.1109/TAFFC.2026.3689490",
    note: "核心成员，梳理大语言模型在心理健康领域的发展脉络与前沿技术路径",
  },
];
