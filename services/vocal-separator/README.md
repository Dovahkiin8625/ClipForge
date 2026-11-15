# ClipForge 人声分离服务

这是一个**独立于 ClipForge 主程序**的可选服务。它只做一件事：把一段录音里的人声
分离出来。

ClipForge 通过 HTTP 与它通信。服务没启动时，主程序会自动回退到内置的
FFmpeg 中置声道提取，功能照常可用——神经网络从来不是必需品。

## 为什么是独立的服务

- 主程序不需要 Python、不需要 PyTorch、不需要下载模型，装机体积不变。
- 模型可以单独升级、单独部署，甚至放在另一台机器上。
- 以后要接别的模型（BS-RoFormer、Open-Unmix……），只需要在这个服务里加一个
  provider，ClipForge 一行代码都不用改。

## 运行

```bash
cd services/vocal-separator

python -m venv .venv
.venv/Scripts/activate        # Windows；macOS/Linux 用 source .venv/bin/activate

pip install -r requirements.txt
pip install demucs            # 可选：装上才有神经网络

python run.py --port 8777
```

服务默认监听 `127.0.0.1:8777`。

## 让 ClipForge 找到它

两种方式，二选一：

1. 环境变量（优先）：

   ```bash
   CLIPFORGE_VOCAL_SERVICE=http://127.0.0.1:8777
   ```

2. 配置文件：在 ClipForge 的用户数据目录（`%APPDATA%/clipforge` 或
   `~/Library/Application Support/clipforge`）下放一个 `vocal-service.json`：

   ```json
   { "baseUrl": "http://127.0.0.1:8777" }
   ```

服务不可用时，ClipForge 的「人声分离」会使用内置的 FFmpeg 中置声道提取。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/health` | 服务状态与可用 provider 列表 |
| `GET` | `/providers` | 可用 provider 列表 |
| `POST` | `/separate` | 上传音频，开始一个任务，返回 `job_id` |
| `GET` | `/jobs/{job_id}` | 任务状态与进度 |
| `POST` | `/jobs/{job_id}/cancel` | 取消任务 |
| `GET` | `/files/{file_id}` | 下载分离结果（WAV） |

`POST /separate` 接受 `multipart/form-data`：`file`（音频）、`provider`（可选）、
`model`（可选）、`name`（可选）。

接口定义在 `vocal_separator/protocol.py`，与主程序里的 `src/shared/vocals.ts`
一一对应，改动时需要同步。

## 加一个新的模型

1. 在 `vocal_separator/providers/` 下新建一个文件，实现 `VocalProvider`：

   ```python
   class MyProvider(VocalProvider):
       id = "my-model"
       label = "我的模型"
       kind = "model"

       def models(self): return [ModelSpec("v1", "版本 1")]
       def available(self): return (True, None)
       def separate(self, source, out_dir, model, report, cancel) -> Path:
           ...
           return out_dir / "vocals.wav"
   ```

2. 在 `vocal_separator/providers/__init__.py` 里 `register(MyProvider())`。

3. 完事。主程序会自动在「人声分离」里用上它。

`kind = "model"` 的 provider 会被优先使用；`kind = "filter"` 的作为兜底。
