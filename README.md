# 💗 心跳别墅 · Heartbeat Villa

> 四个夜晚，六位单身男女，一座藏着秘密的海岛别墅。还有一块只说真话的大屏幕。

一款 1–6 人联机的 3D 恋爱综艺网页游戏。打开链接，开一间别墅，把邀请链接发给朋友，大家一起入住。空出来的嘉宾位由 AI 补上，一个人也能玩。

**▶ 在线游玩：** https://haidongnie.github.io/heartbeat-villa/

## 怎么玩

1. 点 **开一间别墅**，选一位嘉宾，然后点 **💌 邀请** 把链接发给朋友。
2. 人齐后由房主点 **🎬 开播**。一局大约 12–15 分钟。
3. 四个夜晚：
   - **第一夜 · 初见**：自由交流，当众送出玫瑰，再匿名发一条心动短信。
   - **第二夜 · 爆料**：大屏幕公开某位嘉宾的秘密。当事人可以承认、否认或甩锅，其他人选择站不站 TA。然后暴雨来袭。
   - **第三夜 · 篝火真心话**：酒瓶转到谁，谁就要当众点名回答。
   - **终夜 · 心动告白**：秘密告白，互选成功就是双向奔赴，然后颁奖，每个人有一段专属结局。

| 操作 | 电脑 | 手机 |
| --- | --- | --- |
| 移动 | WASD / 方向键（Shift 快走） | 左下摇杆 |
| 视角 | 拖动鼠标、滚轮缩放 | 拖动屏幕 |
| 表情 | 1–6 或底部按钮 | 底部按钮 |
| 送玫瑰 | 靠近某人后按 R | 🌹 按钮 |
| 聊天 | Enter | 输入框 |

剧情、人设和每位嘉宾的秘密见 [GAME_DESIGN.md](GAME_DESIGN.md)。

## 技术

- **渲染**：Three.js r186 `WebGPURenderer`（不支持 WebGPU 时自动回退到 WebGL2）。使用 AgX 色调映射、HDRI 环境光、单盏投影太阳光，昼夜和暴雨的光照会过渡；后期是 TSL 节点做的 Bloom、调色和 SMAA。
- **3D 资产**：全部角色和道具都由 [Meshy](https://www.meshy.ai) 的 `meshy-t2.5`（Smart Topology）文生 3D 生成，经过 PBR 精修。7 个角色走了自动绑骨，每个带 7–10 段动作。资产管线在 `tools/` 里。
- **联机**：[Playroom Kit](https://joinplayroom.com)。房主跑“导演”状态机（`src/game/director.ts`），负责推进剧情、汇总秘密选择、驱动 AI 嘉宾。房主掉线后，下一位玩家会接着当房主。
- **音频**：全部用 WebAudio 实时合成，不需要下载任何音频文件。

```
src/
  core/      渲染器与后期、资源加载
  world/     海岛场景、大屏幕、粒子特效、碰撞
  game/      主循环与剧情脚本、导演（房主）、角色、镜头、联机封装
  ui/        DOM 界面（选角、HUD、花字、选择卡、结局）
  data/      剧本：人设、台词、真心话卡、结局
tools/       Meshy 生成脚本、glTF 压缩、检查工具
```

## 本地开发

```bash
npm install
npm run dev        # http://localhost:5173/heartbeat-villa/   （加 ?fast=1 可以快进流程，加 ?q=low 使用低画质）
npm run build
```

### Playroom gameId（可选，但建议配置）

不填 gameId 也能联机，但 Playroom 会在控制台给出警告，以后还可能限制日活。配置方法：

1. 在 https://dev.joinplayroom.com 创建项目，复制 gameId。
2. 在 GitHub 仓库的 **Settings → Secrets and variables → Actions → Variables** 里新建变量 `PLAYROOM_GAME_ID`，然后重新运行部署工作流。本地开发时可以写进 `.env.local`：`VITE_PLAYROOM_GAME_ID=...`。

### 重新生成 / 新增 Meshy 资产

提示词都在 `tools/assets.manifest.json`。已经创建过的任务 ID 记录在 `tools/meshy-tasks.json` 里，所以重复运行不会重复扣费。

```bash
MESHY_API_KEY=你的密钥 npm run meshy -- --only 资产id   # 生成：预览 → 精修 → 绑骨 → 动作
npm run assets:optimize -- 资产id                        # 压缩到 public/models，并生成立绘
```

> API 密钥只通过环境变量传入，永远不要写进代码或提交到仓库。

## 素材与授权

- 角色和道具模型：仓库作者用 Meshy 生成。
- HDRI `belfast_sunset_puresky` 以及沙滩、木甲板、瓷砖贴图：[Poly Haven](https://polyhaven.com)，CC0。
- 水面法线贴图：three.js 示例资源（MIT）。
- 字体：Google Fonts 的 ZCOOL KuaiLe 和 Noto Sans SC（OFL）。
