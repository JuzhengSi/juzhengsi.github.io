// get the ninja-keys element
const ninja = document.querySelector('ninja-keys');

// add the home and posts menu items
ninja.data = [{
    id: "nav-主页",
    title: "主页",
    section: "Navigation",
    handler: () => {
      window.location.href = "/";
    },
  },{id: "nav-简历",
          title: "简历",
          description: "个人简历与经历概览。",
          section: "Navigation",
          handler: () => {
            window.location.href = "/cv/";
          },
        },{id: "projects-多智能体图像编辑系统",
          title: '多智能体图像编辑系统',
          description: "面向多图输入、复杂自然语言指令与异构视觉工具协同的图像编辑系统。",
          section: "Projects",handler: () => {
              window.location.href = "/projects/multi-agent-image-editing/";
            },},];
