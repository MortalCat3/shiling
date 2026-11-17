# 媒体处理能力（@shiling/media）

媒体处理能力包，提供图片、MP4 与自包含 HTML/ZIP 的受控探测能力。图片使用 Sharp，视频通过受限参数调用系统 FFprobe/FFmpeg；动效处理器目前只用于离线结构验证和风险验证，其 manifest/静态说明图不能作为可用预览或 ready 证据。

具体安全边界见 [src/processors/README.md](src/processors/README.md)。可信任务进程（worker）负责协调，隔离执行器只接受必要输入输出能力；领域发布和权限决定不能放入处理器。

浏览器前端不能导入本包。跨包调用仅使用公开入口和明确声明的工作区依赖。视频部署必须提供 `ffprobe` 与 `ffmpeg`；缺失时对应任务安全失败，不会退化为未校验的 ready。
