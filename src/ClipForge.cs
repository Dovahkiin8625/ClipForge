using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace ClipForge
{
    // ================= 基础工具 =================
    internal static class U
    {
        public static readonly string[] VideoExt = new string[] { "mp4", "mkv", "mov", "flv", "avi", "webm", "ts", "m4v", "wmv", "mpg", "mpeg", "3gp" };
        public static readonly string[] AudioExt = new string[] { "mp3", "m4a", "aac", "wav", "flac", "ogg", "opus", "wma", "ac3", "eac3", "amr", "mka", "ape" };

        public static string ExeDir()
        {
            try
            {
                string d = Path.GetDirectoryName(Application.ExecutablePath);
                if (d != null) return d;
            }
            catch { }
            return Environment.CurrentDirectory;
        }

        public static string Q(string p) { return "\"" + p + "\""; }

        public static string Ext(string p)
        {
            return Path.GetExtension(p).TrimStart('.').ToLowerInvariant();
        }

        public static bool IsVideo(string p) { return Array.IndexOf(VideoExt, Ext(p)) >= 0; }
        public static bool IsAudio(string p) { return Array.IndexOf(AudioExt, Ext(p)) >= 0; }

        public static string FmtTime(double s)
        {
            if (s <= 0) return "--:--";
            int total = (int)Math.Round(s);
            int h = total / 3600;
            int m = (total % 3600) / 60;
            int sec = total % 60;
            if (h > 0) return string.Format("{0}:{1:00}:{2:00}", h, m, sec);
            return string.Format("{0:00}:{1:00}", m, sec);
        }

        // 带小数秒的时间文本（滑块与时间框同步用）：00:07.3 / 1:02:07.3；整秒不带小数
        public static string FmtTimeP(double s)
        {
            if (s < 0) s = 0;
            int frac = (int)Math.Round((s - Math.Floor(s)) * 10);
            int total = (int)Math.Floor(s);
            if (frac >= 10) { total++; frac = 0; }
            int h = total / 3600;
            int m = (total % 3600) / 60;
            int sec = total % 60;
            string fracTxt = frac > 0 ? "." + frac : "";
            if (h > 0) return string.Format("{0}:{1:00}:{2:00}{3}", h, m, sec, fracTxt);
            return string.Format("{0:00}:{1:00}{2}", m, sec, fracTxt);
        }

        // 文件名归一化：去掉扩展名、扩展名以外的分隔符，只留字母数字（含中日韩文字）
        public static string NormName(string p)
        {
            string n = Path.GetFileNameWithoutExtension(p).ToLowerInvariant();
            StringBuilder sb = new StringBuilder(n.Length);
            foreach (char c in n) if (char.IsLetterOrDigit(c)) sb.Append(c);
            return sb.ToString();
        }

        private static int TrailingNumber(string s)
        {
            int end = s.Length;
            while (end > 0 && !char.IsDigit(s[end - 1])) end--;
            if (end == 0) return -1;
            int start = end;
            while (start > 0 && char.IsDigit(s[start - 1])) start--;
            int v = 0;
            int.TryParse(s.Substring(start, end - start), out v);
            return v;
        }

        // 文件名相似度：完全一致=1；公共前缀/后缀越长越接近；末尾序号相同也算部分相似（如 video01 / audio01）
        public static double NameSim(string a, string b)
        {
            if (a.Length == 0 || b.Length == 0) return 0;
            if (string.Equals(a, b, StringComparison.Ordinal)) return 1.0;
            int min = Math.Min(a.Length, b.Length);
            int max = Math.Max(a.Length, b.Length);
            if (min == 0) return 0;
            int pc = 0;
            while (pc < min && a[pc] == b[pc]) pc++;
            int sc = 0;
            while (sc < min && a[a.Length - 1 - sc] == b[b.Length - 1 - sc]) sc++;
            double sim = Math.Max(pc, sc) / (double)max;
            int na = TrailingNumber(a), nb = TrailingNumber(b);
            if (na >= 0 && nb >= 0 && na == nb) sim = Math.Max(sim, 0.35);
            if (sim > 1.0) sim = 1.0;
            return sim;
        }

        public static string FmtSize(long b)
        {
            if (b >= 1024L * 1024 * 1024) return string.Format("{0:0.00} GB", b / (1024.0 * 1024 * 1024));
            if (b >= 1024 * 1024) return string.Format("{0:0.0} MB", b / (1024.0 * 1024));
            if (b >= 1024) return string.Format("{0:0.0} KB", b / 1024.0);
            return b + " B";
        }

        public static string UniquePath(string dir, string baseName, string ext)
        {
            string p = Path.Combine(dir, baseName + ext);
            if (!File.Exists(p)) return p;
            for (int i = 2; i < 999; i++)
            {
                p = Path.Combine(dir, baseName + " (" + i + ")" + ext);
                if (!File.Exists(p)) return p;
            }
            return p;
        }

        public static string CrashLog(Exception ex)
        {
            try
            {
                string p = Path.Combine(ExeDir(), "crash.log");
                StringBuilder sb = new StringBuilder();
                sb.AppendLine(DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss"));
                sb.AppendLine(ex.ToString());
                File.AppendAllText(p, sb.ToString(), Encoding.Unicode);
                return p;
            }
            catch { return ""; }
        }
    }

    // ================= 设置读写 =================
    internal static class Cfg
    {
        private static string PathFile { get { return Path.Combine(U.ExeDir(), "settings.ini"); } }

        public static string Get(string key)
        {
            try
            {
                if (!File.Exists(PathFile)) return "";
                string[] lines = File.ReadAllLines(PathFile, Encoding.Unicode);
                foreach (string raw in lines)
                {
                    string line = raw.Trim();
                    int idx = line.IndexOf('=');
                    if (idx <= 0) continue;
                    if (line.Substring(0, idx).Trim() == key) return line.Substring(idx + 1).Trim();
                }
            }
            catch { }
            return "";
        }

        public static void Set(string key, string val)
        {
            try
            {
                List<string> lines = new List<string>();
                bool replaced = false;
                if (File.Exists(PathFile))
                {
                    string[] old = File.ReadAllLines(PathFile, Encoding.Unicode);
                    foreach (string raw in old)
                    {
                        string line = raw.Trim();
                        int idx = line.IndexOf('=');
                        if (idx > 0 && line.Substring(0, idx).Trim() == key)
                        {
                            lines.Add(key + "=" + val);
                            replaced = true;
                        }
                        else lines.Add(raw);
                    }
                }
                if (!replaced) lines.Add(key + "=" + val);
                File.WriteAllLines(PathFile, lines.ToArray(), Encoding.Unicode);
            }
            catch { }
        }
    }

    // ================= ffmpeg 定位 =================
    internal static class Ffmpeg
    {
        public static string FfmpegPath = "";
        public static string FfprobePath = "";
        public static string LastError = "";

        public static bool Detect()
        {
            LastError = "";

            string saved = Cfg.Get("ffmpeg");
            if (saved.Length > 0 && File.Exists(saved))
            {
                FfmpegPath = saved;
                FfprobePath = Sibling(saved, "ffprobe.exe");
                return true;
            }

            List<string> dirs = new List<string>();
            try
            {
                string pathEnv = Environment.GetEnvironmentVariable("PATH");
                if (pathEnv != null)
                {
                    string[] parts = pathEnv.Split(';');
                    foreach (string p in parts) if (p.Trim().Length > 0) dirs.Add(p.Trim().TrimEnd('\\') + "\\");
                }
            }
            catch { }

            string exeDir = U.ExeDir();
            dirs.Add(exeDir);
            dirs.Add(Path.Combine(exeDir, "bin"));
            dirs.Add(Path.Combine(exeDir, "lib"));
            dirs.Add(Path.Combine(exeDir, "ffmpeg"));
            dirs.Add(Path.Combine(exeDir, "ffmpeg", "bin"));

            string[] known = new string[]
            {
                @"D:\Program Files\ffmpeg-master-latest-win64-gpl-shared\bin",
                @"D:\Program Files\ffmpeg\bin",
                @"C:\ffmpeg\bin",
                @"C:\Program Files\ffmpeg\bin",
                @"C:\Program Files (x86)\ffmpeg\bin"
            };
            foreach (string k in known) dirs.Add(k);

            foreach (string d in dirs)
            {
                try
                {
                    string f = Path.Combine(d, "ffmpeg.exe");
                    if (File.Exists(f))
                    {
                        FfmpegPath = f;
                        FfprobePath = Sibling(f, "ffprobe.exe");
                        Cfg.Set("ffmpeg", f);
                        return true;
                    }
                }
                catch { }
            }

            LastError = "未找到 ffmpeg.exe";
            return false;
        }

        private static string Sibling(string ffmpegPath, string name)
        {
            try
            {
                string dir = Path.GetDirectoryName(ffmpegPath);
                string p = Path.Combine(dir, name);
                if (File.Exists(p)) return p;
            }
            catch { }
            return "";
        }

        public static bool Ready { get { return FfmpegPath.Length > 0 && File.Exists(FfmpegPath); } }
        public static bool ProbeReady { get { return FfprobePath.Length > 0 && File.Exists(FfprobePath); } }
    }

    // ================= N_m3u8DL-CLI 定位 =================
    internal static class M3u8DL
    {
        public static string ExePath = "";
        public static string LastError = "";

        public static bool Detect()
        {
            LastError = "";
            ExePath = "";

            string saved = Cfg.Get("m3u8dl");
            if (saved.Length > 0 && File.Exists(saved))
            {
                ExePath = saved;
                return true;
            }

            string exeDir = U.ExeDir();
            string[] dirs = new string[] { exeDir, Path.Combine(exeDir, "lib") };
            try
            {
                string[] names = new string[] { "N_m3u8DL-CLI_v3.0.2.exe", "N_m3u8DL-CLI.exe", "N_m3u8DL-RE.exe" };
                foreach (string d in dirs)
                {
                    foreach (string n in names)
                    {
                        string p = Path.Combine(d, n);
                        if (File.Exists(p)) { ExePath = p; Cfg.Set("m3u8dl", p); return true; }
                    }
                }
                foreach (string d in dirs)
                {
                    if (!Directory.Exists(d)) continue;
                    string[] files = Directory.GetFiles(d, "N_m3u8DL*.exe");
                    if (files != null && files.Length > 0) { ExePath = files[0]; Cfg.Set("m3u8dl", files[0]); return true; }
                }
            }
            catch { }

            LastError = "未找到 N_m3u8DL-CLI";
            return false;
        }

        public static bool Ready { get { return ExePath.Length > 0 && File.Exists(ExePath); } }
    }

    // ================= 下载记录 =================
    internal class DownloadRecord
    {
        public string Id = "";
        public string Url = "";
        public string FileName = "";
        public string SaveDir = "";
        public string OutputPath = "";
        public string Mode = "";         // m3u8 / ffmpeg
        public string Status = "";       // 等待 / 下载中 / 完成 / 失败 / 已停止
        public long Size = 0;
        public double Duration = 0;
        public string Message = "";
        public string CreatedAt = "";
        public string FinishedAt = "";
        [System.NonSerialized] public ListViewItem Row;
    }

    internal static class DownloadHistory
    {
        private static string HistoryPath { get { return Path.Combine(U.ExeDir(), "download_history.txt"); } }

        private static string Esc(string s)
        {
            if (s == null) return "";
            return s.Replace("\\", "\\\\").Replace("\t", "\\t").Replace("\r", "\\r").Replace("\n", "\\n");
        }

        private static string Unesc(string s)
        {
            if (s == null || s.Length == 0) return "";
            StringBuilder sb = new StringBuilder(s.Length);
            for (int i = 0; i < s.Length; i++)
            {
                char c = s[i];
                if (c == '\\' && i + 1 < s.Length)
                {
                    char n = s[i + 1];
                    if (n == '\\') { sb.Append('\\'); i++; continue; }
                    if (n == 't') { sb.Append('\t'); i++; continue; }
                    if (n == 'r') { sb.Append('\r'); i++; continue; }
                    if (n == 'n') { sb.Append('\n'); i++; continue; }
                }
                sb.Append(c);
            }
            return sb.ToString();
        }

        public static List<DownloadRecord> Load()
        {
            List<DownloadRecord> list = new List<DownloadRecord>();
            try
            {
                if (!File.Exists(HistoryPath)) return list;
                string[] lines = File.ReadAllLines(HistoryPath, Encoding.UTF8);
                foreach (string line in lines)
                {
                    if (string.IsNullOrEmpty(line) || line.StartsWith("#")) continue;
                    string[] p = line.Split('\t');
                    if (p.Length < 6) continue;
                    DownloadRecord r = new DownloadRecord();
                    r.Id = p.Length > 0 ? Unesc(p[0]) : "";
                    r.Url = p.Length > 1 ? Unesc(p[1]) : "";
                    r.FileName = p.Length > 2 ? Unesc(p[2]) : "";
                    r.SaveDir = p.Length > 3 ? Unesc(p[3]) : "";
                    r.OutputPath = p.Length > 4 ? Unesc(p[4]) : "";
                    r.Mode = p.Length > 5 ? Unesc(p[5]) : "";
                    r.Status = p.Length > 6 ? Unesc(p[6]) : "";
                    if (p.Length > 7) long.TryParse(Unesc(p[7]), out r.Size);
                    if (p.Length > 8) double.TryParse(Unesc(p[8]), System.Globalization.NumberStyles.Any, System.Globalization.CultureInfo.InvariantCulture, out r.Duration);
                    r.Message = p.Length > 9 ? Unesc(p[9]) : "";
                    r.CreatedAt = p.Length > 10 ? Unesc(p[10]) : "";
                    r.FinishedAt = p.Length > 11 ? Unesc(p[11]) : "";
                    if (r.Status == "下载中") r.Status = "已停止"; // 上次异常退出
                    list.Add(r);
                }
            }
            catch { }
            return list;
        }

        public static void Save(List<DownloadRecord> list)
        {
            try
            {
                List<string> lines = new List<string>();
                lines.Add("# DownloadHistory v1");
                if (list != null)
                {
                    foreach (DownloadRecord r in list)
                    {
                        lines.Add(string.Join("\t", new string[] {
                            Esc(r.Id), Esc(r.Url), Esc(r.FileName), Esc(r.SaveDir), Esc(r.OutputPath),
                            Esc(r.Mode), Esc(r.Status), r.Size.ToString(), r.Duration.ToString(System.Globalization.CultureInfo.InvariantCulture),
                            Esc(r.Message), Esc(r.CreatedAt), Esc(r.FinishedAt)
                        }));
                    }
                }
                File.WriteAllLines(HistoryPath, lines.ToArray(), new UTF8Encoding(false));
            }
            catch { }
        }
    }

    // ================= 媒体信息 =================
    internal class MediaInfo
    {
        public double Duration;
        public string Codec = "";
        public int Width;
        public int Height;
    }

    internal class AudioTrackInfo
    {
        public string Codec = "";
        public double Bitrate = 0;
        public int Channels = 0;
    }

    // 拼接前的片段参数快照（用于直接拼接兼容性检查与统一转码对齐目标）
    internal class JoinSpec
    {
        public string File = "";
        public bool HasVideo = false;
        public bool HasAudio = false;
        public string VCodec = "";
        public int W = 0;
        public int H = 0;
        public string FpsTxt = "";          // avg_frame_rate 分数原文，如 "30000/1001"
        public double Fps = 0;
        public long TbNum = 0;              // 时间基
        public long TbDen = 0;
        public string ACodec = "";
        public double ASampleRate = 0;
        public int AChannels = 0;
        public double Duration = 0;

        public string Desc()
        {
            string v = HasVideo
                ? VCodec + " · " + W + "×" + H + " · " + (Fps > 0 ? Math.Round(Fps, 2).ToString("0.###") : "?") + " fps · 时间基 " + TbNum + "/" + TbDen
                : "无视频流";
            string a = HasAudio
                ? ACodec + " · " + (ASampleRate > 0 ? ((int)ASampleRate + "Hz") : "?") + " · " + AChannels + " 声道"
                : "无音频";
            return v + "；音频：" + a;
        }
    }

    internal static class Media
    {
        public static MediaInfo Probe(string file, bool wantVideo)
        {
            MediaInfo mi = new MediaInfo();
            if (!Ffmpeg.ProbeReady) return mi;

            string sel = wantVideo ? "v:0" : "a:0";
            string entries = wantVideo
                ? "stream=codec_name,width,height:format=duration"
                : "stream=codec_name,channels:format=duration";
            string args = "-v error -select_streams " + sel + " -show_entries " + entries +
                          " -of default=nw=1:nk=1 " + U.Q(file);

            string outp = RunProbe(args);
            if (outp.Length == 0) return mi;

            string[] raw = outp.Replace("\r", "").Split('\n');
            List<string> lines = new List<string>();
            foreach (string s in raw)
            {
                string t = s.Trim();
                if (t.Length > 0) lines.Add(t);
            }
            if (lines.Count == 0) return mi;

            try { mi.Duration = double.Parse(lines[lines.Count - 1]); }
            catch { mi.Duration = 0; }

            if (lines.Count >= 3 && wantVideo)
            {
                mi.Codec = lines[0].ToLowerInvariant();
                try { mi.Width = (int)double.Parse(lines[1]); } catch { mi.Width = 0; }
                try { mi.Height = (int)double.Parse(lines[2]); } catch { mi.Height = 0; }
            }
            else if (lines.Count >= 2 && !wantVideo)
            {
                mi.Codec = lines[0].ToLowerInvariant();
            }
            return mi;
        }

        // 列出文件里的每一路音频：编码、比特率、声道数（用于提取时的轨道选择）
        public static List<AudioTrackInfo> ProbeAudioTracks(string file)
        {
            List<AudioTrackInfo> list = new List<AudioTrackInfo>();
            if (!Ffmpeg.ProbeReady) return list;

            string args = "-v error -select_streams a -show_entries stream=codec_name,bit_rate,channels -of default=nw=1 " + U.Q(file);
            string outp = RunProbe(args);
            if (outp.Length == 0) return list;

            AudioTrackInfo cur = null;
            foreach (string s in outp.Replace("\r", "").Split('\n'))
            {
                string t = s.Trim();
                if (t.Length == 0) continue;
                if (t.StartsWith("codec_name="))
                {
                    cur = new AudioTrackInfo();
                    cur.Codec = t.Substring(11).ToLowerInvariant();
                    list.Add(cur);
                }
                else if (t.StartsWith("bit_rate=") && cur != null)
                {
                    try { cur.Bitrate = double.Parse(t.Substring(9)); } catch { }
                }
                else if (t.StartsWith("channels=") && cur != null)
                {
                    try { cur.Channels = (int)double.Parse(t.Substring(9)); } catch { }
                }
            }
            return list;
        }

        // 拼接前探测：视频编码 / 分辨率 / 帧率 / 时间基 + 音频编码 / 采样率 / 声道 + 时长
        public static JoinSpec ProbeJoin(string file)
        {
            JoinSpec s = new JoinSpec();
            s.File = file;
            if (!Ffmpeg.ProbeReady) return s;

            Dictionary<string, string> kv = KvParse(RunProbe(
                "-v error -select_streams v:0 -show_entries stream=codec_name,width,height,avg_frame_rate,time_base -of default=nw=1 " + U.Q(file)));
            if (kv.ContainsKey("codec_name") && kv["codec_name"].Length > 0 && kv["codec_name"] != "N/A")
            {
                s.HasVideo = true;
                s.VCodec = kv["codec_name"].ToLowerInvariant();
            }
            s.W = KvInt(kv, "width");
            s.H = KvInt(kv, "height");
            string fps;
            if (kv.TryGetValue("avg_frame_rate", out fps)) s.FpsTxt = fps;
            if (fps != null && fps.Length > 0 && fps != "0/0" && fps.IndexOf('/') > 0)
            {
                string[] fp = fps.Split('/');
                double fn, fd;
                if (double.TryParse(fp[0], out fn) && double.TryParse(fp[1], out fd) && fd > 0) s.Fps = fn / fd;
            }
            else s.FpsTxt = "";
            string tb;
            if (kv.TryGetValue("time_base", out tb) && tb != null && tb.IndexOf('/') > 0)
            {
                string[] tp = tb.Split('/');
                long tn, td;
                if (long.TryParse(tp[0], out tn) && long.TryParse(tp[1], out td)) { s.TbNum = tn; s.TbDen = td; }
            }

            kv = KvParse(RunProbe(
                "-v error -select_streams a:0 -show_entries stream=codec_name,sample_rate,channels -of default=nw=1 " + U.Q(file)));
            if (kv.ContainsKey("codec_name") && kv["codec_name"].Length > 0 && kv["codec_name"] != "N/A")
            {
                s.HasAudio = true;
                s.ACodec = kv["codec_name"].ToLowerInvariant();
                s.ASampleRate = KvDouble(kv, "sample_rate");
                s.AChannels = KvInt(kv, "channels");
            }

            string dur = RunProbe("-v error -show_entries format=duration -of default=nw=1:nk=1 " + U.Q(file));
            if (dur.Length > 0)
            {
                string first = dur.Trim().Split('\n')[0];
                try { s.Duration = double.Parse(first); } catch { }
            }
            return s;
        }

        private static Dictionary<string, string> KvParse(string text)
        {
            Dictionary<string, string> d = new Dictionary<string, string>(StringComparer.Ordinal);
            if (text == null) return d;
            foreach (string raw in text.Replace("\r", "").Split('\n'))
            {
                string t = raw.Trim();
                int i = t.IndexOf('=');
                if (i <= 0) continue;
                d[t.Substring(0, i)] = t.Substring(i + 1);
            }
            return d;
        }

        private static int KvInt(Dictionary<string, string> kv, string key)
        {
            string v;
            if (kv.TryGetValue(key, out v))
            {
                int x;
                if (int.TryParse(v, out x)) return x;
            }
            return 0;
        }

        private static double KvDouble(Dictionary<string, string> kv, string key)
        {
            string v;
            if (kv.TryGetValue(key, out v))
            {
                double x;
                if (double.TryParse(v, out x)) return x;
            }
            return 0;
        }

        private static string RunProbe(string args)
        {
            ProcessStartInfo psi = new ProcessStartInfo(Ffmpeg.FfprobePath, args);
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.RedirectStandardOutput = true;
            psi.StandardOutputEncoding = Encoding.UTF8;
            Process p = null;
            try
            {
                p = Process.Start(psi);
                StringBuilder sb = new StringBuilder();
                sb.Append(p.StandardOutput.ReadToEnd());
                p.WaitForExit(15000);
                if (!p.HasExited) { try { p.Kill(); } catch { } }
                return sb.ToString();
            }
            catch { return ""; }
            finally { if (p != null) { try { p.Dispose(); } catch { } } }
        }
    }

    // ================= 任务模型 =================
    internal class Job
    {
        public int Kind = 0;                 // 0=音视频合并 1=提取音频 2=剪辑 3=拼接 4=画面调整 5=格式转换 6=下载
        public string Video = "";
        public string Audio = "";
        public string Output = "";
        public int Mode = 0;                 // 0=直接复制 1=仅音频转AAC 2=全部重编码
        public string Container = "mp4";      // mp4 / mkv
        public bool Shortest = false;
        public double VideoDuration = 0;
        public bool OutputExistedBefore = false;
        public string Exe = "";              // 外部工具路径（为空时按任务类型使用 ffmpeg）
    }

    internal class JobResult
    {
        public bool Ok = false;
        public bool Stopped = false;
        public string Message = "";
        public string Details = "";
        public long Size = 0;
        public double Duration = 0;
        public int ExitCode = -1;
    }

    internal class BatchItem
    {
        public string Video = "";
        public string Audio = "";
        public double VDur = 0;
        public double ADur = 0;
        public double NameScore = 0;        // 文件名相似度（0~1，配对后由算法填写）
        public bool Checked = true;
        public string Status = "待合并";
        public ListViewItem Row;
        public bool Done = false;
    }

    // ================= 可视化剪辑：区间滑块（缩略图条 + 双端把手 + 播放头） =================
    internal class CutSlider : Control
    {
        private double dur = 0;
        private double selStart = 0, selEnd = 0, pos = 0;
        private List<Image> thumbs;
        private int drag = 0;               // 1=拖起点 2=拖终点 3=拖播放头

        public Action Changed;              // 起点 / 终点变化
        public Action PositionChanged;      // 播放头位置变化

        private static readonly Color CTrack = Color.FromArgb(30, 34, 40);
        private static readonly Color CDims = Color.FromArgb(150, 20, 22, 26);
        private static readonly Color CHead = Color.FromArgb(235, 90, 60);

        public CutSlider()
        {
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer |
                     ControlStyles.UserPaint | ControlStyles.ResizeRedraw, true);
            BackColor = Color.White;
            Cursor = Cursors.Hand;
        }

        public void SetDuration(double d)
        {
            dur = d > 0 ? d : 0;
            selStart = 0; selEnd = dur; pos = 0;
            Invalidate();
        }

        public void SetThumbs(List<Image> imgs) { thumbs = imgs; Invalidate(); }

        public double SelStart { get { return selStart; } }
        public double SelEnd { get { return selEnd; } }
        public double CurPos { get { return pos; } }

        private double Clamp(double t)
        {
            if (dur <= 0) return 0;
            if (t < 0) t = 0;
            if (t > dur) t = dur;
            return t;
        }

        // s/e/p 一起设；fire=true 时触发 Changed 回调
        public void SetValues(double s, double e, double p, bool fire)
        {
            if (dur <= 0) { Invalidate(); return; }
            s = Clamp(s); e = Clamp(e);
            if (s > dur - 0.05) s = Math.Max(0, dur - 0.05);
            if (e <= s + 0.05) e = Math.Min(dur, s + 0.05);
            selStart = s; selEnd = e;
            pos = Clamp(p);
            Invalidate();
            if (fire && Changed != null) Changed();
        }

        public void MovePos(double delta)
        {
            if (dur <= 0) return;
            pos = Clamp(pos + delta);
            if (pos < selStart) pos = selStart;
            if (pos > selEnd) pos = selEnd;
            Invalidate();
            if (PositionChanged != null) PositionChanged();
        }

        private double TimeAtX(int x)
        {
            int w = Width - 16;
            if (dur <= 0 || w <= 0) return 0;
            double t = (x - 8) * dur / (double)w;
            return Math.Max(0, Math.Min(dur, t));
        }

        private int XAtTime(double t)
        {
            if (dur <= 0) return 8;
            int w = Width - 16;
            if (w <= 0) return 8;
            return 8 + (int)Math.Round(Clamp(t) * w / dur);
        }

        protected override void OnMouseDown(MouseEventArgs e)
        {
            base.OnMouseDown(e);
            if (e.Button != MouseButtons.Left || dur <= 0) return;
            int xs = XAtTime(selStart), xe = XAtTime(selEnd);
            if (Math.Abs(e.X - xs) <= 6) drag = 1;
            else if (Math.Abs(e.X - xe) <= 6) drag = 2;
            else { drag = 3; SetPos(TimeAtX(e.X)); }
        }

        protected override void OnMouseMove(MouseEventArgs e)
        {
            base.OnMouseMove(e);
            if (dur <= 0) return;
            if (e.Button == MouseButtons.Left && drag != 0)
            {
                double t = TimeAtX(e.X);
                if (drag == 1) SetSelStart(t);
                else if (drag == 2) SetSelEnd(t);
                else SetPos(t);
                return;
            }
            // 悬停在把手上换光标
            int xs = XAtTime(selStart), xe = XAtTime(selEnd), xp = XAtTime(pos);
            Cursor = (Math.Abs(e.X - xs) <= 6 || Math.Abs(e.X - xe) <= 6) ? Cursors.VSplit : Cursors.Hand;
            if (Math.Abs(e.X - xp) <= 6) Cursor = Cursors.HSplit;
        }

        protected override void OnMouseUp(MouseEventArgs e)
        {
            base.OnMouseUp(e);
            drag = 0;
        }

        private void SetPos(double t)
        {
            pos = Clamp(t);
            Invalidate();
            if (PositionChanged != null) PositionChanged();
        }

        private void SetSelStart(double t)
        {
            double v = Clamp(t);
            if (v > selEnd - 0.1) v = Math.Max(0, selEnd - 0.1);
            selStart = v;
            Invalidate();
            if (Changed != null) Changed();
        }

        private void SetSelEnd(double t)
        {
            double v = Clamp(t);
            if (v < selStart + 0.1) v = Math.Min(dur, selStart + 0.1);
            selEnd = v;
            Invalidate();
            if (Changed != null) Changed();
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            g.Clear(BackColor);
            int x0 = 8, w = ClientRectangle.Width - 16;
            int y0 = 2, h = ClientRectangle.Height - 4;
            if (w <= 10 || h <= 4) return;

            using (Brush b = new SolidBrush(CTrack)) g.FillRectangle(b, x0, y0, w, h);

            if (dur <= 0)
            {
                string txt = "选择视频后显示缩略图";
                Font f = new Font("Microsoft YaHei UI", 8.25F);
                SizeF sz = g.MeasureString(txt, f);
                using (Brush b = new SolidBrush(Color.FromArgb(150, 158, 166)))
                    g.DrawString(txt, f, b, x0 + w / 2 - sz.Width / 2, y0 + h / 2 - sz.Height / 2);
                f.Dispose();
                return;
            }

            // 缩略图条（均匀铺满整条）
            int n = thumbs != null ? thumbs.Count : 0;
            if (n > 0)
            {
                double slot = dur / n;
                for (int i = 0; i < n; i++)
                {
                    int cx = XAtTime(i * slot);
                    int cw = XAtTime((i + 1) * slot) - cx;
                    if (i == n - 1) cw = x0 + w - cx;
                    if (cw < 1) cw = 1;
                    if (thumbs[i] != null) DrawCropped(g, thumbs[i], new Rectangle(cx, y0, cw, h));
                }
            }

            // 两端以外压暗、选中区高亮
            int xs = XAtTime(selStart), xe = XAtTime(selEnd);
            using (Brush dim = new SolidBrush(CDims))
            {
                int lw = Math.Max(0, xs - x0);
                if (lw > 0) g.FillRectangle(dim, x0, y0, lw, h);
                int rw = Math.Max(0, x0 + w - xe);
                if (rw > 0) g.FillRectangle(dim, xe, y0, rw, h);
            }
            using (Brush hl = new SolidBrush(Color.FromArgb(80, 90, 160, 240)))
                g.FillRectangle(hl, xs, y0, Math.Max(2, xe - xs), h);

            DrawHandle(g, xs, true);
            DrawHandle(g, xe, false);

            // 播放头
            int xp = XAtTime(pos);
            if (xp < x0) xp = x0;
            if (xp > x0 + w) xp = x0 + w;
            using (Pen p = new Pen(CHead, 2)) g.DrawLine(p, xp, y0 + 12, xp, y0 + h - 2);
            using (Brush b = new SolidBrush(CHead))
            {
                Point[] tri = new Point[] { new Point(xp - 5, y0 + 1), new Point(xp + 5, y0 + 1), new Point(xp, y0 + 10) };
                g.FillPolygon(b, tri);
            }
        }

        // 选区两端的白色把手竖条
        private void DrawHandle(Graphics g, int x, bool start)
        {
            int y0 = 2, h = ClientRectangle.Height - 4;
            using (Brush b = new SolidBrush(Color.White))
                g.FillRectangle(b, x - 4, y0 + 14, 8, h - 28);
            using (Pen p = new Pen(Color.FromArgb(43, 108, 176), 1))
                g.DrawRectangle(p, x - 4, y0 + 14, 8, h - 28);
        }

        // 等比裁中绘制（缩略图填格子不变形）
        private void DrawCropped(Graphics g, Image img, Rectangle tr)
        {
            int iw = img.Width, ih = img.Height;
            if (iw <= 0 || ih <= 0) return;
            double ta = tr.Width / (double)Math.Max(1, tr.Height);
            double ia = iw / (double)ih;
            Rectangle src;
            if (ia > ta)
            {
                int sw = Math.Max(1, (int)Math.Round(ih * ta));
                src = new Rectangle((iw - sw) / 2, 0, sw, ih);
            }
            else
            {
                int sh = Math.Max(1, (int)Math.Round(iw / ta));
                src = new Rectangle(0, (ih - sh) / 2, iw, sh);
            }
            try { g.DrawImage(img, tr, src, GraphicsUnit.Pixel); } catch { }
        }
    }

    // ================= 主窗体 =================
    public class MainForm : Form
    {
        // 颜色
        private readonly Color CAccent = Color.FromArgb(43, 108, 176);
        private readonly Color CAccentDark = Color.FromArgb(35, 90, 148);
        private readonly Color CText = Color.FromArgb(38, 44, 52);
        private readonly Color CMuted = Color.FromArgb(108, 117, 128);
        private readonly Color COk = Color.FromArgb(27, 122, 62);
        private readonly Color CErr = Color.FromArgb(190, 46, 40);
        private readonly Color CBg = Color.FromArgb(247, 248, 250);

        private Font fBase;
        private Font fSmall;
        private Font fBold;
        private Font fLog;

        // 单文件控件
        private TextBox txtVideo;
        private TextBox txtAudio;
        private TextBox txtOut;
        private Button btnPickVideo;
        private Button btnPickAudio;
        private Button btnPickOut;
        private Label lblVideoInfo;
        private Label lblAudioInfo;
        private ComboBox cmbFormat;
        private CheckBox chkOpenFolder;
        private RadioButton rdoCopy;
        private RadioButton rdoAac;
        private RadioButton rdoReencode;
        private CheckBox chkShortest;
        private Button btnStart;
        private Button btnStop;
        private Button btnClear;
        private Button btnOpenOut;
        private Button btnFindFfmpeg;
        private Label lblStatus;
        private ProgressBar progress;
        private TextBox txtLog;

        // 批量控件
        private Button btnScan;
        private Label lblScanInfo;
        private ListView lvBatch;
        private ComboBox cmbBatchFormat;
        private ComboBox cmbBatchMode;
        private CheckBox chkBatchShortest;
        private Button btnBatchStart;
        private Button btnBatchStop;
        private Button btnBatchOpen;
        private ProgressBar progressBatch;
        private Label lblBatchStatus;

        // 音频提取控件
        private TextBox txtExSrc;
        private Button btnExPick;
        private Label lblExInfo;
        private ComboBox cmbExTrack;
        private ComboBox cmbExFormat;
        private ComboBox cmbExQuality;
        private CheckBox chkExSame;
        private TextBox txtExOut;
        private Button btnExOut;
        private Button btnExStart;
        private Button btnExStop;
        private Label lblExStatus;
        private ProgressBar exProgress;
        private TextBox exLog;

        // 视频剪辑控件
        private TextBox txtCutSrc;
        private Button btnCutPick;
        private Label lblCutInfo;
        private TextBox txtCutStart;
        private TextBox txtCutEnd;
        private Label lblCutDurHint;
        private RadioButton rdoCutFast;
        private RadioButton rdoCutAcc;
        private ComboBox cmbCutFormat;
        private CheckBox chkCutSame;
        private TextBox txtCutOut;
        private Button btnCutOut;
        private Button btnCutStart;
        private Button btnCutStop;
        private Label lblCutStatus;
        private ProgressBar cutProgress;
        private TextBox cutLog;
        private double cutSrcDur = 0;

        // 视频剪辑：可视化预览与区间选择
        private PictureBox picCutPreview;
        private Label lblCutPrevHint;
        private Label lblCutPos;
        private CutSlider cutSlider;
        private Button btnCutMarkStart;
        private Button btnCutMarkEnd;
        private Button btnCutNudgeL;
        private Button btnCutNudgeR;
        private ToolTip tips;
        private System.Windows.Forms.Timer cutPreviewTimer;
        private double pendingPreviewPos = -1;
        private bool cutSync = false;           // 时间框 <-> 滑块 双向同步防回环
        private int cutToken = 0;               // 缩略图任务序号（换视频即作废旧任务）
        private int cutPrevToken = 0;           // 预览帧任务序号
        private List<Image> cutThumbs = new List<Image>();
        private string cutTempDir = "";

        // 视频拼接控件
        private ListBox lstClips;
        private Button btnClipAdd;
        private Button btnClipRemove;
        private Button btnClipUp;
        private Button btnClipDown;
        private Button btnClipClear;
        private RadioButton rdoJoinCopy;
        private RadioButton rdoJoinEncode;
        private ComboBox cmbClipFormat;
        private TextBox txtClipOut;
        private Button btnClipOut;
        private Button btnClipStart;
        private Button btnClipStop;
        private Label lblClipStatus;
        private ProgressBar clipProgress;
        private TextBox clipLog;
        private string joinListFile = "";        // 直接拼接时的临时清单文件

        // 画面调整控件
        private TextBox txtPicSrc;
        private Button btnPicPick;
        private Label lblPicInfo;
        private CheckBox chkPicRotate;
        private ComboBox cmbPicRotate;
        private CheckBox chkPicHFlip;
        private CheckBox chkPicVFlip;
        private CheckBox chkPicScale;
        private ComboBox cmbPicSize;
        private TextBox txtCropTop;
        private TextBox txtCropBottom;
        private TextBox txtCropLeft;
        private TextBox txtCropRight;
        private TrackBar trkPicBright;
        private Label lblPicBrightVal;
        private TrackBar trkPicContrast;
        private Label lblPicContrastVal;
        private TrackBar trkPicSat;
        private Label lblPicSatVal;
        private ComboBox cmbPicFormat;
        private CheckBox chkPicSame;
        private TextBox txtPicOut;
        private Button btnPicOut;
        private Button btnPicStart;
        private Button btnPicStop;
        private Label lblPicStatus;
        private ProgressBar picProgress;
        private TextBox picLog;

        // 画面调整：可视化预览（原始帧 + 实时调整效果）
        private PictureBox picOrig;
        private PictureBox picAdj;
        private Label hintPicOrig;
        private Label hintPicAdj;
        private Label lblPicPos;
        private Label lblPicSummary;
        private TrackBar trkPicPos;
        private Button btnPicRegrab;
        private ToolTip picTips;
        private System.Windows.Forms.Timer picFrameTimer;   // 取样位置去抖
        private double pendingPicFrame = -1;
        private Bitmap picFrame;                // 当前取样位原始帧
        private double picSrcDur = 0;
        private int picToken = 0;               // 换视频即作废旧取帧任务
        private int picFrameToken = 0;          // 帧请求序号
        private string picTempDir = "";

        // 格式转换控件
        private TextBox txtCvSrc;
        private Button btnCvPick;
        private Label lblCvInfo;
        private ComboBox cmbCvFormat;
        private ComboBox cmbCvQuality;
        private ComboBox cmbCvScale;
        private ComboBox cmbCvAudio;
        private CheckBox chkCvFast;
        private CheckBox chkCvSame;
        private TextBox txtCvOut;
        private Button btnCvOut;
        private Button btnCvStart;
        private Button btnCvStop;
        private Label lblCvStatus;
        private ProgressBar cvProgress;
        private TextBox cvLog;

        // 视频下载控件
        private TextBox txtDlUrl;
        private ComboBox cmbDlType;
        private TextBox txtDlDir;
        private Button btnDlDir;
        private TextBox txtDlName;
        private Button btnDlStart;
        private Button btnDlStop;
        private Button btnDlOpen;
        private Label lblDlStatus;
        private ProgressBar dlProgress;
        private TextBox dlLog;
        private Label lblDlHint;
        private Button btnFindM3u8;
        private ListView lvDlHistory;
        private List<DownloadRecord> dlRecords = new List<DownloadRecord>();
        private DownloadRecord currentDlRecord;

        private TabControl tabs;

        // 合并页模式切换
        private RadioButton rdoModeSingle;
        private RadioButton rdoModeBatch;
        private Panel pSingle;
        private Panel pBatch;

        // 运行状态
        private Process proc;
        private ProcessStartInfo psiCurrent;
        private bool running = false;
        private bool stopRequested = false;
        private Job currentJob;
        private Action<JobResult> onDone;
        private DateTime startedAt;
        private long lastUs = 0;
        private System.Windows.Forms.Timer ticker;
        private ProgressBar jobProg;            // 当前任务使用的进度条（合并页 / 提取页）
        private string jobRunningText = "合并中…";
        private TextBox activeLog;              // 当前任务日志落到哪个框（默认主日志）

        private readonly List<string> outQueue = new List<string>();
        private readonly List<string> errQueue = new List<string>();
        private readonly object queueLock = new object();
        private List<string> errTail = new List<string>();

        // 批量状态
        private List<BatchItem> batchItems = new List<BatchItem>();
        private int batchIndex = -1;
        private bool batchRunning = false;
        private int probeToken = 0;

        // 输出路径是否被用户手工指定
        private bool outManual = false;
        private bool suppressOut = false;

        public void JumpToTab(int index)
        {
            tabs.SelectedIndex = index;
            Application.DoEvents();
        }
        public int TabCount { get { return tabs.TabPages.Count; } }
        public bool UiRunning { get { return running; } }
        public string UiStatus { get { return lblStatus.Text; } }
        public string UiLog { get { return txtLog.Text; } }

        public void UiStart(string v, string a, string o)
        {
            txtVideo.Text = v;
            txtAudio.Text = a;
            outManual = true;
            txtOut.Text = o;
            Application.DoEvents();
            OnStart(null, EventArgs.Empty);
        }

        // 自测用：直接在音频提取页发起一次提取
        public void UiExtract(string src, string o)
        {
            tabs.SelectedIndex = 1;
            chkExSame.Checked = false;
            txtExSrc.Text = src;
            txtExOut.Text = o;
            Application.DoEvents();
            OnExStart(null, EventArgs.Empty);
        }

        // 自测用：在视频剪辑页载入源视频（不发起剪辑）
        public void UiCut(string src)
        {
            tabs.SelectedIndex = 2;
            txtCutSrc.Text = src;
            Application.DoEvents();
        }

        // 自测用：在视频剪辑页设置起止时间并发起一次剪辑
        public void UiCutRun(string src, string start, string end, string o)
        {
            tabs.SelectedIndex = 2;
            chkCutSame.Checked = false;
            txtCutSrc.Text = src;
            txtCutStart.Text = start;
            txtCutEnd.Text = end;
            txtCutOut.Text = o;
            Application.DoEvents();
            OnCutStart(null, EventArgs.Empty);
        }

        // 自测用：在视频拼接页加入片段并发起一次拼接
        public void UiJoin(string[] clips, string output, bool encode)
        {
            tabs.SelectedIndex = 3;
            lstClips.Items.Clear();
            foreach (string c in clips) lstClips.Items.Add(Path.GetFullPath(c));
            txtClipOut.Text = output;
            if (encode) rdoJoinEncode.Checked = true;
            else rdoJoinCopy.Checked = true;
            Application.DoEvents();
            OnJoinStart(null, EventArgs.Empty);
        }

        // 自测用：拼接页状态与日志（拼LogFile 走 clipLog 而不是主日志）
        public string UiJoinStatus { get { return lblClipStatus == null ? "" : lblClipStatus.Text; } }
        public string UiJoinLog { get { return clipLog == null ? "" : clipLog.Text; } }

        // 自测用状态
        public int CutThumbCount { get { return cutThumbs != null ? cutThumbs.Count : 0; } }
        public bool CutHasPreview { get { return picCutPreview != null && picCutPreview.Image != null; } }
        public string CutStartText { get { return txtCutStart == null ? "" : txtCutStart.Text; } }
        public string CutEndText { get { return txtCutEnd == null ? "" : txtCutEnd.Text; } }

        // 自测用：在画面调整页载入源视频（不发起处理）
        public void UiPic(string src)
        {
            tabs.SelectedIndex = 4;
            txtPicSrc.Text = src;
            Application.DoEvents();
        }

        // 自测用：在画面调整页设置输出并发起一次处理
        public void UiPicRun(string src, string o)
        {
            tabs.SelectedIndex = 4;
            chkPicSame.Checked = false;
            txtPicSrc.Text = src;
            txtPicOut.Text = o;
            Application.DoEvents();
            OnPicStart(null, EventArgs.Empty);
        }

        // 自测用：画面调整页状态与预览状态
        public string UiPicStatus { get { return lblPicStatus == null ? "" : lblPicStatus.Text; } }
        public string UiPicLog { get { return picLog == null ? "" : picLog.Text; } }
        public bool PicHasFrame { get { return picFrame != null; } }
        public bool PicHasAdj { get { return picAdj != null && picAdj.Image != null; } }

        // 自测用：在格式转换页设置源文件与目标格式（fmtIdx 对应 cmbCvFormat 序号）并发起一次转换
        public void UiConvert(string src, string o, int fmtIdx)
        {
            tabs.SelectedIndex = 5;
            chkCvSame.Checked = false;
            txtCvSrc.Text = src;
            txtCvOut.Text = o;
            if (fmtIdx >= 0) cmbCvFormat.SelectedIndex = fmtIdx;
            Application.DoEvents();
            OnCvStart(null, EventArgs.Empty);
        }

        // 自测用：格式转换页状态与日志
        public string UiConvertStatus { get { return lblCvStatus == null ? "" : lblCvStatus.Text; } }
        public string UiConvertLog { get { return cvLog == null ? "" : cvLog.Text; } }

        // 自测用：设置一组调整参数并发起处理（rotIdx -1 = 不旋转；scaleIdx -1 = 不缩放）
        public void UiPicRun2(string src, string o, int rotIdx, bool hflip, bool vf, int scaleIdx,
            int ctop, int cbottom, int cleft, int cright, int bright, int contrast, int sat)
        {
            tabs.SelectedIndex = 4;
            chkPicSame.Checked = false;
            txtPicSrc.Text = src;
            txtPicOut.Text = o;
            if (rotIdx >= 0) { cmbPicRotate.SelectedIndex = rotIdx; chkPicRotate.Checked = true; }
            else chkPicRotate.Checked = false;
            chkPicHFlip.Checked = hflip;
            chkPicVFlip.Checked = vf;
            if (scaleIdx >= 0) { cmbPicSize.SelectedIndex = scaleIdx; chkPicScale.Checked = true; }
            else chkPicScale.Checked = false;
            txtCropTop.Text = ctop.ToString();
            txtCropBottom.Text = cbottom.ToString();
            txtCropLeft.Text = cleft.ToString();
            txtCropRight.Text = cright.ToString();
            trkPicBright.Value = bright;
            trkPicContrast.Value = contrast;
            trkPicSat.Value = sat;
            Application.DoEvents();
            OnPicStart(null, EventArgs.Empty);
        }

        public MainForm()
        {
            fBase = new Font("Microsoft YaHei UI", 9F);
            fSmall = new Font("Microsoft YaHei UI", 8.25F);
            fBold = new Font("Microsoft YaHei UI", 9.5F, FontStyle.Bold);
            fLog = new Font("Consolas", 9F);

            SuspendLayout();
            BuildUi();
            ResumeLayout(false);
            Load += OnLoad;
            FormClosed += OnClosed;
        }

        // ---------------- 组件工厂 ----------------
        private Label MakeLabel(string text, int x, int y, int w, int h)
        {
            Label l = new Label();
            l.Text = text;
            l.Location = new Point(x, y);
            l.Size = new Size(w, h);
            l.TextAlign = ContentAlignment.MiddleLeft;
            l.ForeColor = CText;
            l.AutoEllipsis = true;
            return l;
        }

        private Label MakeHint(string text, int x, int y, int w, int h)
        {
            Label l = MakeLabel(text, x, y, w, h);
            l.Font = fSmall;
            l.ForeColor = CMuted;
            return l;
        }

        private TextBox MakeBox(int x, int y, int w, int h)
        {
            TextBox t = new TextBox();
            t.Location = new Point(x, y);
            t.Size = new Size(w, h);
            t.BorderStyle = BorderStyle.FixedSingle;
            return t;
        }

        private Button MakeButton(string text, int x, int y, int w, int h, bool primary)
        {
            Button b = new Button();
            b.Text = text;
            b.Location = new Point(x, y);
            b.Size = new Size(w, h);
            b.FlatStyle = FlatStyle.Flat;
            b.FlatAppearance.BorderSize = 1;
            b.Cursor = Cursors.Hand;
            b.UseVisualStyleBackColor = false;
            if (primary)
            {
                b.BackColor = CAccent;
                b.ForeColor = Color.White;
                b.FlatAppearance.BorderColor = CAccent;
            }
            else
            {
                b.BackColor = Color.White;
                b.ForeColor = CText;
                b.FlatAppearance.BorderColor = Color.FromArgb(206, 212, 220);
            }
            return b;
        }

        private GroupBox MakeGroup(string title, int x, int y, int w, int h)
        {
            GroupBox g = new GroupBox();
            g.Text = title;
            g.Location = new Point(x, y);
            g.Size = new Size(w, h);
            g.ForeColor = CText;
            g.BackColor = Color.White;
            g.Padding = new Padding(8);
            return g;
        }

        // ---------------- 界面 ----------------
        private void BuildUi()
        {
            Text = "ClipForge";
            ClientSize = new Size(960, 830);
            MinimumSize = new Size(880, 860);
            StartPosition = FormStartPosition.CenterScreen;
            BackColor = CBg;
            Font = fBase;
            AutoScaleMode = AutoScaleMode.None;
            AllowDrop = true;
            DragEnter += OnDragEnter;
            DragDrop += OnDragDrop;

            tabs = new TabControl();
            tabs.Location = new Point(8, 8);
            tabs.Size = new Size(944, 810);
            tabs.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right | AnchorStyles.Bottom;
            tabs.Font = fBase;
            Controls.Add(tabs);

            BuildMergePage();
            BuildExtractPage();
            BuildCutPage();
            BuildJoinPage();
            BuildPicturePage();
            BuildConvertPage();
            BuildDownloadPage();

            ticker = new System.Windows.Forms.Timer();
            ticker.Interval = 250;
            ticker.Tick += OnTick;
        }

        private void BuildMergePage()
        {
            TabPage page = new TabPage("音视频合并");
            page.BackColor = CBg;
            page.Padding = new Padding(0);
            tabs.TabPages.Add(page);
            page.Size = new Size(936, 630);

            rdoModeSingle = new RadioButton();
            rdoModeSingle.Text = "单个合并";
            rdoModeSingle.Location = new Point(14, 4);
            rdoModeSingle.Size = new Size(100, 26);
            rdoModeSingle.Font = fBold;
            rdoModeSingle.Checked = true;
            rdoModeSingle.ForeColor = CText;
            rdoModeSingle.CheckedChanged += OnMergeModeChanged;
            page.Controls.Add(rdoModeSingle);

            rdoModeBatch = new RadioButton();
            rdoModeBatch.Text = "批量合并";
            rdoModeBatch.Location = new Point(122, 4);
            rdoModeBatch.Size = new Size(100, 26);
            rdoModeBatch.Font = fBold;
            rdoModeBatch.ForeColor = CText;
            rdoModeBatch.CheckedChanged += OnMergeModeChanged;
            page.Controls.Add(rdoModeBatch);

            page.Controls.Add(MakeHint("选择合并模式（拖入文件夹或多个文件会自动切换到批量模式）", 246, 8, 660, 20));

            pSingle = new Panel();
            pSingle.Location = new Point(0, 36);
            pSingle.Size = new Size(936, 594);
            pSingle.BackColor = CBg;
            pSingle.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right | AnchorStyles.Bottom;
            page.Controls.Add(pSingle);

            pBatch = new Panel();
            pBatch.Location = new Point(0, 36);
            pBatch.Size = new Size(936, 594);
            pBatch.BackColor = CBg;
            pBatch.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right | AnchorStyles.Bottom;
            pBatch.Visible = false;
            page.Controls.Add(pBatch);

            BuildSingleArea(pSingle);
            BuildBatchArea(pBatch);
        }

        private void OnMergeModeChanged(object sender, EventArgs e)
        {
            if (pSingle == null || pBatch == null || rdoModeSingle == null || rdoModeBatch == null) return;
            pSingle.Visible = rdoModeSingle.Checked;
            pBatch.Visible = rdoModeBatch.Checked;
        }

        private void SwitchToBatchMode()
        {
            tabs.SelectedIndex = 0;
            rdoModeBatch.Checked = true;
        }

        public void JumpMergeBatch()
        {
            SwitchToBatchMode();
            Application.DoEvents();
        }

        private void BuildSingleArea(Panel host)
        {
            // --- 源文件 ---
            GroupBox gSrc = MakeGroup("① 选择要合并的文件", 10, 0, 916, 156);
            gSrc.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
            host.Controls.Add(gSrc);

            gSrc.Controls.Add(MakeLabel("视频文件", 14, 24, 84, 24));

            txtVideo = MakeBox(104, 22, 646, 27);
            txtVideo.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
            txtVideo.AllowDrop = true;
            txtVideo.DragEnter += OnDragEnter;
            txtVideo.DragDrop += OnDragDrop;
            txtVideo.TextChanged += OnVideoChanged;
            gSrc.Controls.Add(txtVideo);

            btnPickVideo = MakeButton("浏览…", 774, 20, 128, 32, false);
            btnPickVideo.Anchor = AnchorStyles.Top | AnchorStyles.Right;
            btnPickVideo.Click += OnPickVideo;
            gSrc.Controls.Add(btnPickVideo);

            lblVideoInfo = MakeHint("", 106, 52, 790, 18);
            gSrc.Controls.Add(lblVideoInfo);

            gSrc.Controls.Add(MakeLabel("音频文件", 14, 88, 84, 24));

            txtAudio = MakeBox(104, 86, 646, 27);
            txtAudio.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
            txtAudio.AllowDrop = true;
            txtAudio.DragEnter += OnDragEnter;
            txtAudio.DragDrop += OnDragDrop;
            txtAudio.TextChanged += OnAudioChanged;
            gSrc.Controls.Add(txtAudio);

            btnPickAudio = MakeButton("浏览…", 774, 84, 128, 32, false);
            btnPickAudio.Anchor = AnchorStyles.Top | AnchorStyles.Right;
            btnPickAudio.Click += OnPickAudio;
            gSrc.Controls.Add(btnPickAudio);

            lblAudioInfo = MakeHint("", 106, 116, 790, 18);
            gSrc.Controls.Add(lblAudioInfo);

            Label hint = MakeHint("提示：可直接把文件拖进来（拖到窗口任意位置都行，会自动识别是视频还是音频；拖入文件夹会进入批量模式）", 14, 136, 890, 18);
            gSrc.Controls.Add(hint);

            // --- 输出 ---
            GroupBox gOut = MakeGroup("② 输出设置", 10, 164, 916, 104);
            gOut.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
            host.Controls.Add(gOut);

            gOut.Controls.Add(MakeLabel("输出文件", 14, 24, 84, 24));

            txtOut = MakeBox(104, 22, 646, 27);
            txtOut.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
            txtOut.TextChanged += OnOutChanged;
            gOut.Controls.Add(txtOut);

            btnPickOut = MakeButton("另存为…", 774, 20, 128, 32, false);
            btnPickOut.Anchor = AnchorStyles.Top | AnchorStyles.Right;
            btnPickOut.Click += OnPickOut;
            gOut.Controls.Add(btnPickOut);

            gOut.Controls.Add(MakeLabel("保存格式", 14, 64, 60, 24));

            cmbFormat = new ComboBox();
            cmbFormat.DropDownStyle = ComboBoxStyle.DropDownList;
            cmbFormat.Location = new Point(78, 62);
            cmbFormat.Size = new Size(170, 26);
            cmbFormat.Items.Add("MP4（推荐，到处能播）");
            cmbFormat.Items.Add("MKV（兼容性最强）");
            cmbFormat.SelectedIndex = 0;
            cmbFormat.SelectedIndexChanged += OnFormatChanged;
            gOut.Controls.Add(cmbFormat);

            chkOpenFolder = new CheckBox();
            chkOpenFolder.Text = "合并完成后自动打开输出所在文件夹";
            chkOpenFolder.Location = new Point(276, 63);
            chkOpenFolder.Size = new Size(300, 24);
            chkOpenFolder.Checked = true;
            chkOpenFolder.ForeColor = CText;
            gOut.Controls.Add(chkOpenFolder);

            // --- 合并方式 ---
            GroupBox gMode = MakeGroup("③ 合并方式", 10, 276, 916, 104);
            gMode.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
            host.Controls.Add(gMode);

            rdoCopy = MakeRadio("直接复制音视频流（最快 · 无损，推荐）", 14, 22, 620);
            rdoCopy.Checked = true;
            gMode.Controls.Add(rdoCopy);

            rdoAac = MakeRadio("视频原样复制，音频转成 AAC（源音频格式与 MP4 不兼容时用）", 14, 48, 700);
            gMode.Controls.Add(rdoAac);

            rdoReencode = MakeRadio("全部重新编码为 H.264 + AAC（前两种都报错时用，较慢）", 14, 74, 600);
            gMode.Controls.Add(rdoReencode);

            chkShortest = new CheckBox();
            chkShortest.Text = "以较短一路的时长为准";
            chkShortest.Location = new Point(630, 74);
            chkShortest.Size = new Size(230, 24);
            chkShortest.ForeColor = Muted();
            chkShortest.Font = fSmall;
            gMode.Controls.Add(chkShortest);

            // --- 执行区 ---
            GroupBox gRun = MakeGroup("④ 开始合并", 10, 388, 916, 198);
            gRun.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right | AnchorStyles.Bottom;
            host.Controls.Add(gRun);

            btnStart = MakeButton("开始合并", 14, 20, 150, 38, true);
            btnStart.Click += OnStart;
            gRun.Controls.Add(btnStart);

            btnStop = MakeButton("停止", 172, 20, 100, 38, false);
            btnStop.Enabled = false;
            btnStop.Click += OnStop;
            gRun.Controls.Add(btnStop);

            btnClear = MakeButton("清空日志", 280, 20, 100, 38, false);
            btnClear.Click += OnClearLog;
            gRun.Controls.Add(btnClear);

            btnOpenOut = MakeButton("打开输出目录", 388, 20, 132, 38, false);
            btnOpenOut.Click += OnOpenOutFolder;
            gRun.Controls.Add(btnOpenOut);

            btnFindFfmpeg = MakeButton("指定 ffmpeg", 528, 20, 124, 38, false);
            btnFindFfmpeg.Visible = false;
            btnFindFfmpeg.Click += OnFindFfmpeg;
            gRun.Controls.Add(btnFindFfmpeg);

            lblStatus = MakeLabel("就绪", 528, 24, 372, 30);
            lblStatus.Anchor = AnchorStyles.Top | AnchorStyles.Right;
            lblStatus.TextAlign = ContentAlignment.MiddleRight;
            lblStatus.Font = fBold;
            gRun.Controls.Add(lblStatus);

            progress = new ProgressBar();
            progress.Location = new Point(14, 66);
            progress.Size = new Size(886, 18);
            progress.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
            progress.Minimum = 0;
            progress.Maximum = 100;
            progress.Value = 0;
            gRun.Controls.Add(progress);

            txtLog = new TextBox();
            txtLog.Location = new Point(14, 92);
            txtLog.Size = new Size(886, 98);
            txtLog.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right | AnchorStyles.Bottom;
            txtLog.Multiline = true;
            txtLog.ReadOnly = true;
            txtLog.ScrollBars = ScrollBars.Vertical;
            txtLog.BackColor = Color.FromArgb(252, 252, 253);
            txtLog.BorderStyle = BorderStyle.FixedSingle;
            txtLog.Font = fLog;
            txtLog.ForeColor = Color.FromArgb(60, 66, 74);
            gRun.Controls.Add(txtLog);
        }

        private Color Muted() { return CMuted; }

        private RadioButton MakeRadio(string text, int x, int y, int w)
        {
            RadioButton r = new RadioButton();
            r.Text = text;
            r.Location = new Point(x, y);
            r.Size = new Size(w, 24);
            r.ForeColor = CText;
            return r;
        }

        private void BuildBatchArea(Panel host)
        {
            host.Controls.Add(MakeHint("① 选择一个文件夹，自动扫出里面的视频与音频，并按「文件名 + 时长」自动配对（结果可在下方核对、勾选）", 12, 4, 912, 22));

            btnScan = MakeButton("扫描文件夹…", 12, 32, 160, 34, true);
            btnScan.Click += OnScanFolder;
            host.Controls.Add(btnScan);

            lblScanInfo = MakeHint("尚未扫描", 182, 36, 740, 26);
            host.Controls.Add(lblScanInfo);

            lvBatch = new ListView();
            lvBatch.Location = new Point(12, 74);
            lvBatch.Size = new Size(914, 372);
            lvBatch.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right | AnchorStyles.Bottom;
            lvBatch.View = View.Details;
            lvBatch.CheckBoxes = true;
            lvBatch.FullRowSelect = true;
            lvBatch.GridLines = false;
            lvBatch.MultiSelect = false;
            lvBatch.HideSelection = false;
            lvBatch.BorderStyle = BorderStyle.FixedSingle;
            lvBatch.Columns.Add("视频文件", 300, HorizontalAlignment.Left);
            lvBatch.Columns.Add("音频文件", 280, HorizontalAlignment.Left);
            lvBatch.Columns.Add("视频时长", 84, HorizontalAlignment.Center);
            lvBatch.Columns.Add("音频时长", 84, HorizontalAlignment.Center);
            lvBatch.Columns.Add("状态", -2, HorizontalAlignment.Left);
            lvBatch.AllowDrop = true;
            lvBatch.ItemCheck += OnBatchItemCheck;
            lvBatch.ItemDrag += OnBatchItemDrag;
            lvBatch.DragOver += OnBatchListDragOver;
            lvBatch.DragLeave += OnBatchListDragLeave;
            lvBatch.DragDrop += OnBatchListDragDrop;
            host.Controls.Add(lvBatch);

            host.Controls.Add(MakeLabel("输出格式", 12, 464, 62, 24));
            cmbBatchFormat = new ComboBox();
            cmbBatchFormat.DropDownStyle = ComboBoxStyle.DropDownList;
            cmbBatchFormat.Location = new Point(76, 462);
            cmbBatchFormat.Size = new Size(150, 26);
            cmbBatchFormat.Items.Add("MP4（推荐）");
            cmbBatchFormat.Items.Add("MKV（兼容性最强）");
            cmbBatchFormat.SelectedIndex = 0;
            host.Controls.Add(cmbBatchFormat);

            host.Controls.Add(MakeLabel("合并方式", 240, 464, 62, 24));
            cmbBatchMode = new ComboBox();
            cmbBatchMode.DropDownStyle = ComboBoxStyle.DropDownList;
            cmbBatchMode.Location = new Point(304, 462);
            cmbBatchMode.Size = new Size(300, 26);
            cmbBatchMode.Items.Add("直接复制（最快 · 无损）");
            cmbBatchMode.Items.Add("视频复制，音频转 AAC");
            cmbBatchMode.Items.Add("全部重编码 H.264 + AAC");
            cmbBatchMode.SelectedIndex = 0;
            host.Controls.Add(cmbBatchMode);

            chkBatchShortest = new CheckBox();
            chkBatchShortest.Text = "以较短一路时长为准";
            chkBatchShortest.Location = new Point(620, 463);
            chkBatchShortest.Size = new Size(200, 24);
            chkBatchShortest.ForeColor = CMuted;
            chkBatchShortest.Font = fSmall;
            host.Controls.Add(chkBatchShortest);

            btnBatchStart = MakeButton("开始批量合并", 12, 496, 160, 38, true);
            btnBatchStart.Click += OnBatchStart;
            host.Controls.Add(btnBatchStart);

            btnBatchStop = MakeButton("停止", 182, 496, 100, 38, false);
            btnBatchStop.Enabled = false;
            btnBatchStop.Click += OnStop;
            host.Controls.Add(btnBatchStop);

            btnBatchOpen = MakeButton("打开输出目录", 292, 496, 140, 38, false);
            btnBatchOpen.Click += OnOpenOutFolder;
            host.Controls.Add(btnBatchOpen);

            progressBatch = new ProgressBar();
            progressBatch.Location = new Point(12, 544);
            progressBatch.Size = new Size(720, 18);
            progressBatch.Anchor = AnchorStyles.Top | AnchorStyles.Left;
            progressBatch.Maximum = 100;
            host.Controls.Add(progressBatch);

            lblBatchStatus = MakeHint("", 742, 542, 184, 24);
            host.Controls.Add(lblBatchStatus);

            host.Controls.Add(MakeHint("提示：在列表中把某一行拖到另一行上，可把该行音频移过去（两行都有音频则互相交换）；也可以把音频文件直接拖到某一行为它补配。", 12, 568, 914, 18));
        }

        // ---------------- 公共小部件（新页面用） ----------------
        private GroupBox BuildSourceGroup(TabPage page, string title, string caption, string hintText,
            ref TextBox txt, ref Button btn, ref Label info, EventHandler pick)
        {
            GroupBox gSrc = MakeGroup(title, 10, 8, 916, 112);
            gSrc.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
            page.Controls.Add(gSrc);

            gSrc.Controls.Add(MakeLabel(caption, 14, 24, 84, 24));

            txt = MakeBox(104, 22, 646, 27);
            txt.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
            txt.AllowDrop = true;
            txt.DragEnter += OnDragEnter;
            txt.DragDrop += OnDropToBox;
            gSrc.Controls.Add(txt);

            btn = MakeButton("浏览…", 774, 20, 128, 32, false);
            btn.Anchor = AnchorStyles.Top | AnchorStyles.Right;
            btn.Click += pick;
            gSrc.Controls.Add(btn);

            info = MakeHint("", 106, 52, 790, 18);
            gSrc.Controls.Add(info);

            gSrc.Controls.Add(MakeHint(hintText, 14, 80, 880, 20));
            return gSrc;
        }

        private TextBox MakeRunLog()
        {
            TextBox t = new TextBox();
            t.Multiline = true;
            t.ReadOnly = true;
            t.ScrollBars = ScrollBars.Vertical;
            t.BackColor = Color.FromArgb(252, 252, 253);
            t.BorderStyle = BorderStyle.FixedSingle;
            t.Font = fLog;
            t.ForeColor = Color.FromArgb(60, 66, 74);
            return t;
        }

        private GroupBox BuildRunArea(TabPage page, string title, string startText, int y,
            ref Button start, ref Button stop, ref ProgressBar prog, ref Label status, ref TextBox log,
            Func<string> folderGetter, int runHeight)
        {
            GroupBox gRun = MakeGroup(title, 10, y, 916, runHeight);
            gRun.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right | AnchorStyles.Bottom;
            page.Controls.Add(gRun);

            bool compact = runHeight < 190;
            int bh = compact ? 34 : 38;
            int py = compact ? 58 : 68;
            int ly = compact ? 78 : 94;
            int lh = runHeight - ly - 10;

            start = MakeButton(startText, 14, 20, 150, bh, true);
            start.Click += OnTodo;
            gRun.Controls.Add(start);

            stop = MakeButton("停止", 172, 20, 100, bh, false);
            stop.Enabled = false;
            stop.Click += OnTodo;
            gRun.Controls.Add(stop);

            // 每个功能页都有「打开输出目录」
            if (folderGetter != null)
            {
                Button open = MakeButton("打开输出目录", 290, 20, 132, bh, false);
                open.Tag = folderGetter;
                open.Click += OnOpenOutByFunc;
                gRun.Controls.Add(open);
            }

            status = MakeLabel("界面已就绪 · 处理功能开发中", 432, 24, 468, 30);
            status.Anchor = AnchorStyles.Top | AnchorStyles.Right;
            status.TextAlign = ContentAlignment.MiddleRight;
            status.Font = fBold;
            status.ForeColor = CMuted;
            gRun.Controls.Add(status);

            prog = new ProgressBar();
            prog.Location = new Point(14, py);
            prog.Size = new Size(886, 18);
            prog.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
            prog.Minimum = 0;
            prog.Maximum = 100;
            prog.Value = 0;
            gRun.Controls.Add(prog);

            log = new TextBox();
            log.Location = new Point(14, ly);
            log.Size = new Size(886, lh);
            log.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right | AnchorStyles.Bottom;
            log.Multiline = true;
            log.ReadOnly = true;
            log.ScrollBars = ScrollBars.Vertical;
            log.BackColor = Color.FromArgb(252, 252, 253);
            log.BorderStyle = BorderStyle.FixedSingle;
            log.Font = fLog;
            log.ForeColor = Color.FromArgb(60, 66, 74);
            log.Text = "（此区域用于显示处理日志，功能开发中）";
            gRun.Controls.Add(log);
            return gRun;
        }

        private GroupBox BuildOutputGroup(TabPage page, string title, int y, string autoText,
            ref CheckBox chk, ref TextBox txt, ref Button btn, ComboBox fmt, EventHandler[] fmtHandlers)
        {
            GroupBox gOut = MakeGroup(title, 10, y, 916, 88);
            gOut.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
            page.Controls.Add(gOut);

            if (fmt != null)
            {
                gOut.Controls.Add(MakeLabel("输出格式", 14, 24, 62, 24));
                fmt.Location = new Point(80, 22);
                fmt.Size = new Size(140, 26);
                if (fmtHandlers != null)
                {
                    foreach (EventHandler h in fmtHandlers) fmt.SelectedIndexChanged += h;
                }
                gOut.Controls.Add(fmt);

                chk = new CheckBox();
                chk.Text = autoText;
                chk.Location = new Point(246, 22);
                chk.Size = new Size(640, 24);
                chk.Checked = true;
                chk.ForeColor = CText;
                gOut.Controls.Add(chk);
            }
            else
            {
                chk = new CheckBox();
                chk.Text = autoText;
                chk.Location = new Point(14, 22);
                chk.Size = new Size(620, 24);
                chk.Checked = true;
                chk.ForeColor = CText;
                gOut.Controls.Add(chk);

                Label autoHint = MakeHint("自动命名 = 源文件名 + 后缀，也可手动指定路径", 640, 24, 260, 22);
                gOut.Controls.Add(autoHint);
            }

            txt = MakeBox(14, 52, 746, 27);
            txt.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
            txt.AllowDrop = true;
            txt.DragEnter += OnDragEnter;
            txt.DragDrop += OnDropToBox;
            gOut.Controls.Add(txt);

            btn = MakeButton("另存为…", 774, 50, 128, 32, false);
            btn.Anchor = AnchorStyles.Top | AnchorStyles.Right;
            btn.Tag = txt;
            btn.Click += OnSaveOutAs;
            gOut.Controls.Add(btn);
            return gOut;
        }

        private ComboBox MakeCombo(int x, int y, int w, params string[] items)
        {
            ComboBox c = new ComboBox();
            c.DropDownStyle = ComboBoxStyle.DropDownList;
            c.Location = new Point(x, y);
            c.Size = new Size(w, 26);
            foreach (string s in items) c.Items.Add(s);
            c.SelectedIndex = 0;
            return c;
        }

        // ---------------- 音频提取页（界面，功能开发中） ----------------
        private void BuildExtractPage()
        {
            TabPage page = new TabPage("音频提取");
            page.BackColor = CBg;
            page.Padding = new Padding(0);
            tabs.TabPages.Add(page);
            page.Size = new Size(936, 630);

            BuildSourceGroup(page, "① 选择视频", "视频文件",
                "提示：从视频中提取声音为 MP3 / FLAC 等音频文件，可直接把视频拖进来",
                ref txtExSrc, ref btnExPick, ref lblExInfo, new EventHandler(OnPickExSrc));
            txtExSrc.TextChanged += OnExSrcChanged;

            GroupBox gOpt = MakeGroup("② 提取设置", 10, 128, 916, 176);
            gOpt.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
            page.Controls.Add(gOpt);

            gOpt.Controls.Add(MakeLabel("音频轨道", 14, 28, 70, 24));
            cmbExTrack = MakeCombo(104, 26, 220,
                "第 1 路音频（默认）", "第 2 路音频", "自动选择音质最高的一路");
            gOpt.Controls.Add(cmbExTrack);

            gOpt.Controls.Add(MakeLabel("输出格式", 360, 28, 70, 24));
            cmbExFormat = MakeCombo(430, 26, 200,
                "MP3（兼容性最好）", "M4A / AAC（保持音质）", "WAV（无损）", "FLAC（无损）", "OGG（体积更小）");
            cmbExFormat.SelectedIndexChanged += new EventHandler(delegate(object s, EventArgs e) { SuggestExOut(); });
            gOpt.Controls.Add(cmbExFormat);

            gOpt.Controls.Add(MakeLabel("音质", 14, 68, 70, 24));
            cmbExQuality = MakeCombo(104, 66, 220, "高（320 kbps）", "中（192 kbps）", "原样（跟随源）");
            gOpt.Controls.Add(cmbExQuality);

            gOpt.Controls.Add(MakeHint("WAV / FLAC 为无损格式，音质选项对它们不生效。", 104, 104, 800, 20));
            gOpt.Controls.Add(MakeHint("提取声音不会重新压缩画面，速度非常快。", 104, 128, 800, 20));

            BuildOutputGroup(page, "③ 输出位置", 312,
                "自动命名：保存到视频所在目录（视频名_音频.格式）",
                ref chkExSame, ref txtExOut, ref btnExOut, null, null);

            BuildRunArea(page, "④ 开始提取", "开始提取", 420,
                ref btnExStart, ref btnExStop, ref exProgress, ref lblExStatus, ref exLog,
                new Func<string>(delegate() { return PickOpenFolder(txtExOut.Text, txtExSrc.Text); }), 198);

            btnExStart.Click -= OnTodo;
            btnExStart.Click += OnExStart;
            btnExStop.Click -= OnTodo;
            btnExStop.Click += OnStop;
            lblExStatus.Text = "准备就绪";
            exLog.Text = "";
        }

        // ---------------- 音频提取 ----------------

        private static readonly string[] ExExt = new string[] { "mp3", "m4a", "wav", "flac", "ogg" };

        // 某源编码能否直接塞进该容器（用于「原样（跟随源）」直接复制）
        private static bool ExCodecFits(string outExt, string codec)
        {
            if (string.IsNullOrEmpty(codec)) return false;
            switch (outExt)
            {
                case "mp3": return codec == "mp3";
                case "m4a": return codec == "aac";
                case "wav": return codec.StartsWith("pcm_");
                case "flac": return codec == "flac";
                case "ogg": return codec == "vorbis" || codec == "opus";
                default: return false;
            }
        }

        private void OnExStart(object sender, EventArgs e)
        {
            if (batchRunning)
            {
                MessageBox.Show(this, "正在批量合并，请等它结束后再提取。", "提示", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            if (running)
            {
                MessageBox.Show(this, "上一个任务还在进行，请等它结束或点停止。", "提示", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            if (!Ffmpeg.Ready)
            {
                MessageBox.Show(this, "还没有可用的 ffmpeg。请切到合并模式点「指定 ffmpeg」。", "缺少 ffmpeg", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                btnFindFfmpeg.Visible = true;
                return;
            }

            string src = txtExSrc.Text.Trim();
            if (src.Length == 0 || !File.Exists(src))
            {
                MessageBox.Show(this, "请先选择存在的视频文件。", "提示", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }

            if (txtExOut.Text.Trim().Length == 0) SuggestExOut();
            string outRaw = txtExOut.Text.Trim();
            if (outRaw.Length == 0)
            {
                MessageBox.Show(this, "请指定输出文件。", "提示", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }

            int fi = cmbExFormat.SelectedIndex; if (fi < 0) fi = 0;
            string ext = fi < ExExt.Length ? ExExt[fi] : "mp3";

            string fullOut = Path.GetFullPath(outRaw);
            string outDir = Path.GetDirectoryName(fullOut);
            if (outDir == null || !Directory.Exists(outDir))
            {
                MessageBox.Show(this, "输出文件夹不存在：" + outDir, "提示", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }
            if (string.Equals(fullOut, Path.GetFullPath(src), StringComparison.OrdinalIgnoreCase))
            {
                MessageBox.Show(this, "输出文件不能和源文件是同一个，否则会覆盖原始文件。请换个输出文件名。", "提示", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }
            if (U.Ext(fullOut) != ext)
            {
                fullOut = Path.ChangeExtension(fullOut, ext);
                AppendLog("[提示] 输出扩展名已按所选格式改为 ." + ext + "，保存为 " + Path.GetFileName(fullOut));
            }

            // 探测源文件的音频轨道
            List<AudioTrackInfo> tracks = new List<AudioTrackInfo>();
            try { tracks = Media.ProbeAudioTracks(src); } catch { }
            if (tracks.Count == 0)
            {
                MessageBox.Show(this, "这个文件里没有找到音频轨道，无法提取声音。", "提示", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }

            double srcDur = 0;
            try { srcDur = Media.Probe(src, true).Duration; } catch { }

            // 选轨道
            int map = cmbExTrack.SelectedIndex; if (map < 0) map = 0;
            if (map == 2)
            {
                map = 0;
                double best = -1;
                for (int i = 0; i < tracks.Count; i++)
                {
                    double v = tracks[i].Bitrate > 0 ? tracks[i].Bitrate : tracks[i].Channels * 96000;
                    if (v > best) { best = v; map = i; }
                }
                if (tracks.Count > 1 && tracks[map].Bitrate > 0)
                    AppendLog("自动选择第 " + (map + 1) + " 路音频（" + (int)(tracks[map].Bitrate / 1000.0 + 0.5) + " kbps）");
            }
            else if (map >= tracks.Count)
            {
                AppendLog("[提示] 源文件只有 " + tracks.Count + " 路音频，已改用第 1 路。");
                map = 0;
            }
            string srcCodec = map < tracks.Count ? tracks[map].Codec : "";

            // 编码参数
            int qi = cmbExQuality.SelectedIndex; if (qi < 0) qi = 0;
            string codecArgs;
            if (ExCodecFits(ext, srcCodec))
            {
                codecArgs = "-c:a copy";
            }
            else
            {
                int kbps = qi == 0 ? 320 : 192;   // 不兼容容器时，「原样」按中等质量转码
                switch (ext)
                {
                    case "mp3": codecArgs = "-c:a libmp3lame -b:a " + kbps + "k"; break;
                    case "m4a": codecArgs = "-c:a aac -b:a " + kbps + "k"; break;
                    case "wav": codecArgs = "-c:a pcm_s16le"; break;
                    case "flac": codecArgs = "-c:a flac"; break;
                    case "ogg": codecArgs = qi == 0 ? "-c:a libvorbis -q:a 10" : "-c:a libvorbis -q:a 6"; break;
                    default: codecArgs = "-c:a aac -b:a 192k"; break;
                }
            }

            StringBuilder sb = new StringBuilder();
            sb.Append("-hide_banner -nostats -y ");
            sb.Append("-i " + U.Q(src) + " ");
            sb.Append("-map 0:a:" + map + " -vn ");
            sb.Append(codecArgs + " ");
            sb.Append("-max_muxing_queue_size 4096 ");
            sb.Append("-progress pipe:1 ");
            sb.Append("-loglevel info ");
            sb.Append(U.Q(fullOut));

            Job job = new Job();
            job.Kind = 1;
            job.Video = src;
            job.Output = fullOut;
            job.VideoDuration = srcDur;

            AppendLog("—— 提取音频：" + Path.GetFileName(src) + " → " + Path.GetFileName(fullOut)
                + (codecArgs.Contains("copy") ? "（原样复制流）" : "（重新编码）"));
            StartFfmpegJob(sb.ToString(), job, new Action<JobResult>(OnExDone), exProgress, "提取中…");
        }

        private void OnExDone(JobResult r)
        {
            if (r.Ok)
            {
                lblExStatus.Text = "提取完成 ✓";
                AppendLog("完成：输出 " + U.FmtSize(r.Size) + "，时长 " + U.FmtTime(r.Duration));
                if (currentJob != null) AppendLog("文件已保存：" + currentJob.Output);
            }
            else if (r.Stopped)
            {
                lblExStatus.Text = "已停止";
            }
            else
            {
                lblExStatus.Text = "提取失败";
                AppendLog("[失败] " + r.Message);
                string hint = HintForFailure(r.Details);
                if (hint.Length > 0) AppendLog("[建议] " + hint);
            }
        }

        // ---------------- 视频剪辑页 ----------------
        private void BuildCutPage()
        {
            TabPage page = new TabPage("视频剪辑");
            page.BackColor = CBg;
            page.Padding = new Padding(0);
            tabs.TabPages.Add(page);
            page.Size = new Size(936, 630);

            BuildSourceGroup(page, "① 选择视频", "视频文件",
                "提示：把视频里的一段截出来另存为新视频，可直接把视频拖进来",
                ref txtCutSrc, ref btnCutPick, ref lblCutInfo, new EventHandler(OnPickCutSrc));
            txtCutSrc.TextChanged += OnCutSrcChanged;

            tips = new ToolTip();

            // --- ② 预览与区间选择 ---
            GroupBox gPrev = MakeGroup("② 预览与区间选择", 10, 128, 916, 220);
            gPrev.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
            page.Controls.Add(gPrev);

            picCutPreview = new PictureBox();
            picCutPreview.Location = new Point(14, 20);
            picCutPreview.Size = new Size(300, 168);
            picCutPreview.BorderStyle = BorderStyle.FixedSingle;
            picCutPreview.BackColor = Color.FromArgb(26, 30, 36);
            picCutPreview.SizeMode = PictureBoxSizeMode.Zoom;
            gPrev.Controls.Add(picCutPreview);

            lblCutPrevHint = new Label();
            lblCutPrevHint.Text = "选择视频后显示画面预览";
            lblCutPrevHint.Location = new Point(14, 20);
            lblCutPrevHint.Size = new Size(300, 168);
            lblCutPrevHint.TextAlign = ContentAlignment.MiddleCenter;
            lblCutPrevHint.Font = fSmall;
            lblCutPrevHint.BackColor = Color.FromArgb(26, 30, 36);
            lblCutPrevHint.ForeColor = Color.FromArgb(150, 158, 166);
            gPrev.Controls.Add(lblCutPrevHint);

            lblCutPos = MakeHint("", 14, 196, 300, 16);
            lblCutPos.TextAlign = ContentAlignment.MiddleLeft;
            gPrev.Controls.Add(lblCutPos);

            // 区间滑块（缩略图条 + 双端把手 + 播放头）
            cutSlider = new CutSlider();
            cutSlider.Location = new Point(330, 20);
            cutSlider.Size = new Size(556, 56);
            tips.SetToolTip(cutSlider, "左右两端白色把手 = 剪辑起点 / 终点，可拖动；点击任意位置定位预览画面");
            gPrev.Controls.Add(cutSlider);
            cutSlider.Changed = new Action(OnCutSelChanged);
            cutSlider.PositionChanged = new Action(OnCutSliderMoved);

            gPrev.Controls.Add(MakeLabel("开始", 330, 88, 40, 24));
            txtCutStart = MakeBox(372, 86, 104, 27);
            txtCutStart.TextChanged += OnCutTimeChanged;
            tips.SetToolTip(txtCutStart, "格式 00:00:00 或 00:00，可带小数秒，也可拖滑块 / 点「设为开始」");
            gPrev.Controls.Add(txtCutStart);

            gPrev.Controls.Add(MakeLabel("结束", 486, 88, 40, 24));
            txtCutEnd = MakeBox(528, 86, 104, 27);
            txtCutEnd.TextChanged += OnCutTimeChanged;
            tips.SetToolTip(txtCutEnd, "留空 = 剪到视频结尾");
            gPrev.Controls.Add(txtCutEnd);

            btnCutMarkStart = MakeButton("设为开始", 330, 120, 104, 30, false);
            btnCutMarkStart.Click += OnCutMarkStart;
            tips.SetToolTip(btnCutMarkStart, "把预览画面当前位置设为剪辑起点");
            gPrev.Controls.Add(btnCutMarkStart);

            btnCutMarkEnd = MakeButton("设为结尾", 440, 120, 104, 30, false);
            btnCutMarkEnd.Click += OnCutMarkEnd;
            tips.SetToolTip(btnCutMarkEnd, "把预览画面当前位置设为剪辑终点");
            gPrev.Controls.Add(btnCutMarkEnd);

            btnCutNudgeL = MakeButton("◀ 0.2秒", 550, 120, 76, 30, false);
            btnCutNudgeL.Click += OnCutNudgeL;
            gPrev.Controls.Add(btnCutNudgeL);

            btnCutNudgeR = MakeButton("0.2秒 ▶", 630, 120, 76, 30, false);
            btnCutNudgeR.Click += OnCutNudgeR;
            gPrev.Controls.Add(btnCutNudgeR);

            gPrev.Controls.Add(MakeHint("点击滑块定位画面 · 拖动两端选区间", 716, 124, 172, 22));

            rdoCutFast = MakeRadio("快速剪裁（无损 · 秒级完成）", 330, 156, 300);
            rdoCutFast.Checked = true;
            tips.SetToolTip(rdoCutFast, "按起始处最近的关键帧截取，可能有零点几秒偏差，推荐先试它");
            gPrev.Controls.Add(rdoCutFast);

            rdoCutAcc = MakeRadio("精确剪裁（重编码 · 精确）", 644, 156, 250);
            gPrev.Controls.Add(rdoCutAcc);

            lblCutDurHint = MakeHint("", 330, 188, 556, 20);
            gPrev.Controls.Add(lblCutDurHint);

            cmbCutFormat = new ComboBox();
            cmbCutFormat.DropDownStyle = ComboBoxStyle.DropDownList;
            cmbCutFormat.Items.Add("MP4（推荐）");
            cmbCutFormat.Items.Add("MKV（兼容性最强）");
            cmbCutFormat.SelectedIndex = 0;
            cmbCutFormat.SelectedIndexChanged += new EventHandler(delegate(object s, EventArgs e) { SuggestCutOut(); });

            BuildOutputGroup(page, "③ 输出位置", 356,
                "自动命名：保存到视频所在目录（视频名_剪辑.mp4）",
                ref chkCutSame, ref txtCutOut, ref btnCutOut, cmbCutFormat, null);

            BuildRunArea(page, "④ 开始剪辑", "开始剪辑", 452,
                ref btnCutStart, ref btnCutStop, ref cutProgress, ref lblCutStatus, ref cutLog,
                new Func<string>(delegate() { return PickOpenFolder(txtCutOut.Text, txtCutSrc.Text); }), 178);

            btnCutStart.Click -= OnTodo;
            btnCutStart.Click += OnCutStart;
            btnCutStop.Click -= OnTodo;
            btnCutStop.Click += OnStop;
            lblCutStatus.Text = "准备就绪";
            cutLog.Text = "";

            // 预览帧平滑定位用的去抖计时器
            cutPreviewTimer = new System.Windows.Forms.Timer();
            cutPreviewTimer.Interval = 220;
            cutPreviewTimer.Tick += OnCutPreviewTick;
        }

        // ---------------- 视频剪辑：缩略图条 / 预览帧 / 区间同步 ----------------

        // 缩略图条：一次 ffmpeg 从视频均匀抽 N 帧
        private void StartCutThumbs(string src)
        {
            if (!Ffmpeg.Ready || !Ffmpeg.ProbeReady || cutSrcDur <= 0) return;

            cutTempDir = Path.Combine(Path.GetTempPath(), "AVMergeCut_" + Guid.NewGuid().ToString("N").Substring(0, 8));
            try { Directory.CreateDirectory(cutTempDir); }
            catch { cutTempDir = ""; return; }

            int want = 14;
            string inv = System.Globalization.CultureInfo.InvariantCulture.ToString();
            string durStr = cutSrcDur.ToString("0.###", System.Globalization.CultureInfo.InvariantCulture);
            string pattern = Path.Combine(cutTempDir, "t_%03d.jpg");
            string args = "-hide_banner -v error -y -i " + U.Q(src) +
                " -vf \"fps=" + want + "/" + durStr + "\" -frames:v " + want +
                " -q:v 2 -f image2 " + U.Q(pattern);

            int token = cutToken;
            ThreadPool.QueueUserWorkItem(new WaitCallback(delegate(object state)
            {
                RunFfmpegQuiet(args, 60000);

                List<Image> imgs = new List<Image>();
                if (token == cutToken)
                {
                    try
                    {
                        for (int i = 1; i <= want; i++)
                        {
                            string f = Path.Combine(cutTempDir, "t_" + i.ToString("000") + ".jpg");
                            if (!File.Exists(f)) break;
                            using (Image img = Image.FromFile(f)) imgs.Add(new Bitmap(img));
                        }
                    }
                    catch { }
                }

                try
                {
                    this.BeginInvoke(new MethodInvoker(delegate()
                    {
                        if (token != cutToken || cutSlider == null)
                        {
                            foreach (Image im in imgs) im.Dispose();
                            return;
                        }
                        foreach (Image im in cutThumbs) im.Dispose();
                        cutThumbs = imgs;
                        cutSlider.SetThumbs(cutThumbs.Count > 0 ? cutThumbs : null);
                        if (cutThumbs.Count == 0)
                            lblCutPos.Text = "（读不到画面缩略图，仍可在上方填写起止时间）";
                        RequestCutPreview(cutSlider.CurPos);
                    }));
                }
                catch
                {
                    foreach (Image im in imgs) im.Dispose();
                }
            }));
        }

        // 静默跑一次 ffmpeg（缩略图 / 预览帧共用），超时杀掉
        private void RunFfmpegQuiet(string args, int timeoutMs)
        {
            if (!Ffmpeg.Ready) return;
            Process p = null;
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo(Ffmpeg.FfmpegPath, args);
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                p = Process.Start(psi);
                p.WaitForExit(timeoutMs);
                if (!p.HasExited) { try { p.Kill(); } catch { } }
            }
            catch { }
            finally { if (p != null) { try { p.Dispose(); } catch { } } }
        }

        // 播放头移动：去抖后抓取当前位置画面
        private void OnCutPreviewTick(object sender, EventArgs e)
        {
            cutPreviewTimer.Stop();
            if (pendingPreviewPos >= 0)
            {
                double t = pendingPreviewPos;
                pendingPreviewPos = -1;
                RequestCutPreview(t);
            }
        }

        private void RequestCutPreview(double t)
        {
            string src = txtCutSrc.Text.Trim();
            if (src.Length == 0 || !File.Exists(src) || !Ffmpeg.Ready) return;
            if (cutSrcDur <= 0) return;
            if (t < 0) t = 0;
            if (t > cutSrcDur) t = cutSrcDur;
            SetCutPosLabel(t);

            cutPrevToken++;
            int token = cutPrevToken;
            string work = cutTempDir.Length > 0 ? cutTempDir : Path.GetTempPath();
            string outFile = Path.Combine(work, "prev.jpg");

            string ts = t.ToString("0.###", System.Globalization.CultureInfo.InvariantCulture);
            string args = "-hide_banner -v error -y -ss " + ts + " -i " + U.Q(src) +
                " -frames:v 1 -q:v 3 -f image2 " + U.Q(outFile);

            ThreadPool.QueueUserWorkItem(new WaitCallback(delegate(object state)
            {
                RunFfmpegQuiet(args, 30000);

                Bitmap bmp = null;
                if (token == cutPrevToken)
                {
                    try
                    {
                        if (File.Exists(outFile) && new FileInfo(outFile).Length > 0)
                        {
                            using (Image img = Image.FromFile(outFile)) bmp = new Bitmap(img);
                        }
                    }
                    catch { }
                }

                try
                {
                    this.BeginInvoke(new MethodInvoker(delegate()
                    {
                        if (token != cutPrevToken)
                        {
                            if (bmp != null) bmp.Dispose();
                            return;
                        }
                        if (bmp != null)
                        {
                            Image old = picCutPreview.Image;
                            picCutPreview.Image = bmp;
                            if (old != null) old.Dispose();
                            lblCutPrevHint.Visible = false;
                        }
                        else if (picCutPreview.Image == null)
                        {
                            lblCutPrevHint.Visible = true;
                            lblCutPrevHint.Text = "无法读取该位置画面（可能是音频文件）";
                        }
                    }));
                }
                catch { if (bmp != null) bmp.Dispose(); }
            }));
        }

        private void OnCutSliderMoved()
        {
            SetCutPosLabel(cutSlider.CurPos);
            pendingPreviewPos = cutSlider.CurPos;
            cutPreviewTimer.Stop();
            cutPreviewTimer.Start();
        }

        public void OnCutSelChanged()
        {
            if (cutSync) return;
            cutSync = true;
            txtCutStart.Text = U.FmtTimeP(cutSlider.SelStart);
            txtCutEnd.Text = (cutSrcDur > 0 && cutSlider.SelEnd > cutSrcDur - 0.05) ? "" : U.FmtTimeP(cutSlider.SelEnd);
            cutSync = false;
            UpdateCutDurHint();
        }

        private void OnCutMarkStart(object sender, EventArgs e)
        {
            if (cutSlider == null || cutSrcDur <= 0) return;
            cutSlider.SetValues(cutSlider.CurPos, cutSlider.SelEnd, cutSlider.CurPos, true);
        }

        private void OnCutMarkEnd(object sender, EventArgs e)
        {
            if (cutSlider == null || cutSrcDur <= 0) return;
            cutSlider.SetValues(cutSlider.SelStart, cutSlider.CurPos, cutSlider.CurPos, true);
        }

        private void OnCutNudgeL(object sender, EventArgs e)
        {
            if (cutSlider == null || cutSrcDur <= 0) return;
            cutSlider.MovePos(-0.2);
        }

        private void OnCutNudgeR(object sender, EventArgs e)
        {
            if (cutSlider == null || cutSrcDur <= 0) return;
            cutSlider.MovePos(0.2);
        }

        private void SetCutPosLabel(double t)
        {
            if (lblCutPos == null) return;
            if (cutSrcDur <= 0) { lblCutPos.Text = ""; return; }
            lblCutPos.Text = "位置 " + U.FmtTimeP(t) + " · 总 " + U.FmtTime(cutSrcDur);
        }

        // 清掉画面预览与缩略图（控件还在，等新视频）
        private void ClearCutVisuals()
        {
            foreach (Image im in cutThumbs) im.Dispose();
            cutThumbs = new List<Image>();
            if (picCutPreview != null)
            {
                Image old = picCutPreview.Image;
                picCutPreview.Image = null;
                if (old != null) old.Dispose();
            }
            if (lblCutPrevHint != null)
            {
                lblCutPrevHint.Visible = true;
                lblCutPrevHint.Text = "选择视频后显示画面预览";
            }
            if (cutSlider != null) cutSlider.SetThumbs(null);
        }

        // 删除缩略图 / 预览帧临时目录
        private void ClearCutTempDir()
        {
            try { if (cutTempDir.Length > 0 && Directory.Exists(cutTempDir)) Directory.Delete(cutTempDir, true); }
            catch { }
            cutTempDir = "";
        }

        // ---------------- 视频拼接页 ----------------
        private void BuildJoinPage()
        {
            TabPage page = new TabPage("视频拼接");
            page.BackColor = CBg;
            page.Padding = new Padding(0);
            tabs.TabPages.Add(page);
            page.Size = new Size(936, 630);

            GroupBox gList = MakeGroup("① 素材列表（按此顺序拼接）", 10, 8, 916, 260);
            gList.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right | AnchorStyles.Bottom;
            page.Controls.Add(gList);

            btnClipAdd = MakeButton("添加视频片段…", 14, 20, 130, 32, true);
            btnClipAdd.Click += OnPickClipAdd;
            gList.Controls.Add(btnClipAdd);

            btnClipRemove = MakeButton("移除选中", 150, 20, 100, 32, false);
            btnClipRemove.Click += OnClipRemove;
            gList.Controls.Add(btnClipRemove);

            btnClipUp = MakeButton("上移", 256, 20, 70, 32, false);
            btnClipUp.Click += OnClipUp;
            gList.Controls.Add(btnClipUp);

            btnClipDown = MakeButton("下移", 330, 20, 70, 32, false);
            btnClipDown.Click += OnClipDown;
            gList.Controls.Add(btnClipDown);

            btnClipClear = MakeButton("清空", 404, 20, 70, 32, false);
            btnClipClear.Click += OnClipClear;
            gList.Controls.Add(btnClipClear);

            gList.Controls.Add(MakeHint("把多个视频拖进列表即可，按列表顺序首尾拼接成一个视频", 490, 24, 400, 24));

            lstClips = new ListBox();
            lstClips.Location = new Point(14, 64);
            lstClips.Size = new Size(886, 176);
            lstClips.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right | AnchorStyles.Bottom;
            lstClips.BorderStyle = BorderStyle.FixedSingle;
            lstClips.HorizontalScrollbar = true;
            lstClips.AllowDrop = true;
            lstClips.DragEnter += OnDragEnter;
            lstClips.DragDrop += OnDropToList;
            gList.Controls.Add(lstClips);

            GroupBox gJoin = MakeGroup("② 拼接设置与输出", 10, 276, 916, 84);
            gJoin.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
            page.Controls.Add(gJoin);

            rdoJoinCopy = MakeRadio("直接拼接（无重编 · 最快，各片段参数一致时才安全，不一会弹窗提示）", 14, 20, 380);
            rdoJoinCopy.Checked = true;
            gJoin.Controls.Add(rdoJoinCopy);

            rdoJoinEncode = MakeRadio("统一转码拼接（自动统一为 H.264 + AAC · 兼容性最好）", 408, 20, 500);
            gJoin.Controls.Add(rdoJoinEncode);

            gJoin.Controls.Add(MakeLabel("输出格式", 14, 52, 62, 24));
            cmbClipFormat = new ComboBox();
            cmbClipFormat.DropDownStyle = ComboBoxStyle.DropDownList;
            cmbClipFormat.Location = new Point(80, 50);
            cmbClipFormat.Size = new Size(150, 26);
            cmbClipFormat.Items.Add("MP4（推荐）");
            cmbClipFormat.Items.Add("MKV（兼容性最强）");
            cmbClipFormat.SelectedIndex = 0;
            cmbClipFormat.SelectedIndexChanged += OnClipFormatChanged;
            gJoin.Controls.Add(cmbClipFormat);

            txtClipOut = MakeBox(260, 50, 502, 27);
            txtClipOut.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
            txtClipOut.AllowDrop = true;
            txtClipOut.DragEnter += OnDragEnter;
            txtClipOut.DragDrop += OnDropToBox;
            gJoin.Controls.Add(txtClipOut);

            btnClipOut = MakeButton("另存为…", 774, 48, 128, 32, false);
            btnClipOut.Anchor = AnchorStyles.Top | AnchorStyles.Right;
            btnClipOut.Tag = txtClipOut;
            btnClipOut.Click += OnSaveOutAs;
            gJoin.Controls.Add(btnClipOut);

            BuildRunArea(page, "③ 开始拼接", "开始拼接", 368,
                ref btnClipStart, ref btnClipStop, ref clipProgress, ref lblClipStatus, ref clipLog,
                new Func<string>(delegate()
                {
                    if (txtClipOut != null) { string d = DirOrEmpty(txtClipOut.Text); if (d.Length > 0) return d; }
                    if (lstClips != null && lstClips.Items.Count > 0) return DirOrEmpty((string)lstClips.Items[0]);
                    return "";
                }), 198);

            btnClipStart.Click -= OnTodo;
            btnClipStart.Click += OnJoinStart;
            btnClipStop.Click -= OnTodo;
            btnClipStop.Click += OnStop;
            lblClipStatus.Text = "准备就绪";
            clipLog.Text = "";
        }

        // ---------------- 画面调整页 ----------------
        private void BuildPicturePage()
        {
            TabPage page = new TabPage("画面调整");
            page.BackColor = CBg;
            page.Padding = new Padding(0);
            tabs.TabPages.Add(page);
            page.Size = new Size(936, 630);

            BuildSourceGroup(page, "① 选择视频", "视频文件",
                "提示：旋转 / 翻转 / 缩放 / 裁剪画面、调节亮度对比度饱和度，可直接把视频拖进来",
                ref txtPicSrc, ref btnPicPick, ref lblPicInfo, new EventHandler(OnPickPicSrc));
            txtPicSrc.TextChanged += OnPicSrcChanged;

            // --- ② 实时预览：左原图（带裁剪标记）+ 右调整后效果 ---
            GroupBox gPrev = MakeGroup("② 实时预览（拖动滑块选一帧画面，右侧随参数实时变化）", 10, 128, 916, 200);
            gPrev.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
            page.Controls.Add(gPrev);

            // 预览提示
            picTips = new ToolTip();

            picOrig = new PictureBox();
            picOrig.Location = new Point(14, 24);
            picOrig.Size = new Size(288, 130);
            picOrig.BorderStyle = BorderStyle.FixedSingle;
            picOrig.BackColor = Color.FromArgb(26, 30, 36);
            picOrig.SizeMode = PictureBoxSizeMode.Zoom;
            picOrig.Paint += OnPicCropPaint;
            gPrev.Controls.Add(picOrig);

            hintPicOrig = new Label();
            hintPicOrig.Text = "选择视频后自动抓取画面";
            hintPicOrig.Location = new Point(14, 24);
            hintPicOrig.Size = new Size(288, 130);
            hintPicOrig.TextAlign = ContentAlignment.MiddleCenter;
            hintPicOrig.Font = fSmall;
            hintPicOrig.BackColor = Color.FromArgb(26, 30, 36);
            hintPicOrig.ForeColor = Color.FromArgb(150, 158, 166);
            gPrev.Controls.Add(hintPicOrig);

            picAdj = new PictureBox();
            picAdj.Location = new Point(316, 24);
            picAdj.Size = new Size(288, 130);
            picAdj.BorderStyle = BorderStyle.FixedSingle;
            picAdj.BackColor = Color.FromArgb(26, 30, 36);
            picAdj.SizeMode = PictureBoxSizeMode.Zoom;
            gPrev.Controls.Add(picAdj);

            hintPicAdj = new Label();
            hintPicAdj.Text = "调整后画面（实时）";
            hintPicAdj.Location = new Point(316, 24);
            hintPicAdj.Size = new Size(288, 130);
            hintPicAdj.TextAlign = ContentAlignment.MiddleCenter;
            hintPicAdj.Font = fSmall;
            hintPicAdj.BackColor = Color.FromArgb(26, 30, 36);
            hintPicAdj.ForeColor = Color.FromArgb(150, 158, 166);
            gPrev.Controls.Add(hintPicAdj);

            lblPicPos = MakeHint("", 14, 156, 560, 18);
            gPrev.Controls.Add(lblPicPos);

            trkPicPos = new TrackBar();
            trkPicPos.Location = new Point(100, 172);
            trkPicPos.Size = new Size(484, 24);
            trkPicPos.Minimum = 0;
            trkPicPos.Maximum = 100;
            trkPicPos.TickStyle = TickStyle.None;
            trkPicPos.AutoSize = false;
            trkPicPos.Scroll += OnPicPosScroll;
            picTips.SetToolTip(trkPicPos, "拖动选取用哪一帧做预览（0.1 秒步进）");
            gPrev.Controls.Add(trkPicPos);

            btnPicRegrab = MakeButton("重新抓一帧", 620, 148, 130, 30, false);
            btnPicRegrab.Click += OnPicRegrab;
            picTips.SetToolTip(btnPicRegrab, "按滑块当前取样位置重新抓一帧");
            gPrev.Controls.Add(btnPicRegrab);

            lblPicSummary = new Label();
            lblPicSummary.Text = "选择视频后，这里会显示输出尺寸和已启用的调整项。\n（预览为近似效果，实际以输出文件为准）";
            lblPicSummary.Location = new Point(620, 24);
            lblPicSummary.Size = new Size(280, 118);
            lblPicSummary.Font = fSmall;
            lblPicSummary.ForeColor = CText;
            gPrev.Controls.Add(lblPicSummary);

            // --- ③ 调整参数 ---
            GroupBox gAdj = MakeGroup("③ 调整参数（全部为 0 / 不勾选 = 原样）", 10, 336, 916, 150);
            gAdj.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
            page.Controls.Add(gAdj);

            chkPicRotate = new CheckBox();
            chkPicRotate.Text = "旋转";
            chkPicRotate.Location = new Point(14, 22);
            chkPicRotate.Size = new Size(64, 24);
            chkPicRotate.ForeColor = CText;
            gAdj.Controls.Add(chkPicRotate);

            cmbPicRotate = MakeCombo(82, 20, 120, "90°（顺时针）", "180°", "270°（顺时针）");
            gAdj.Controls.Add(cmbPicRotate);

            chkPicHFlip = new CheckBox();
            chkPicHFlip.Text = "水平镜像";
            chkPicHFlip.Location = new Point(216, 22);
            chkPicHFlip.Size = new Size(96, 24);
            chkPicHFlip.ForeColor = CText;
            gAdj.Controls.Add(chkPicHFlip);

            chkPicVFlip = new CheckBox();
            chkPicVFlip.Text = "垂直翻转";
            chkPicVFlip.Location = new Point(318, 22);
            chkPicVFlip.Size = new Size(96, 24);
            chkPicVFlip.ForeColor = CText;
            gAdj.Controls.Add(chkPicVFlip);

            chkPicScale = new CheckBox();
            chkPicScale.Text = "缩放";
            chkPicScale.Location = new Point(428, 22);
            chkPicScale.Size = new Size(64, 24);
            chkPicScale.ForeColor = CText;
            gAdj.Controls.Add(chkPicScale);

            cmbPicSize = MakeCombo(496, 20, 130, "1920×1080", "1280×720", "854×480", "640×360");
            gAdj.Controls.Add(cmbPicSize);

            gAdj.Controls.Add(MakeHint("自动保持宽高比，不足之处补黑边", 640, 23, 250, 22));

            gAdj.Controls.Add(MakeLabel("裁剪", 14, 60, 44, 24));
            gAdj.Controls.Add(MakeLabel("上", 62, 62, 18, 24));
            txtCropTop = MakeBox(82, 58, 52, 27);
            txtCropTop.Text = "0";
            gAdj.Controls.Add(txtCropTop);
            gAdj.Controls.Add(MakeLabel("下", 146, 62, 18, 24));
            txtCropBottom = MakeBox(166, 58, 52, 27);
            txtCropBottom.Text = "0";
            gAdj.Controls.Add(txtCropBottom);
            gAdj.Controls.Add(MakeLabel("左", 230, 62, 18, 24));
            txtCropLeft = MakeBox(250, 58, 52, 27);
            txtCropLeft.Text = "0";
            gAdj.Controls.Add(txtCropLeft);
            gAdj.Controls.Add(MakeLabel("右", 314, 62, 18, 24));
            txtCropRight = MakeBox(334, 58, 52, 27);
            txtCropRight.Text = "0";
            gAdj.Controls.Add(txtCropRight);
            gAdj.Controls.Add(MakeHint("四边各裁掉几个像素（0 = 不裁），预览中的红色虚线框即裁剪保留区", 400, 60, 480, 22));

            gAdj.Controls.Add(MakeLabel("调色", 14, 102, 44, 24));

            gAdj.Controls.Add(MakeLabel("亮度", 62, 102, 40, 24));
            trkPicBright = MakeAdjTrack(104, 98, 150);
            gAdj.Controls.Add(trkPicBright);
            lblPicBrightVal = MakeValLabel(258, 102);
            gAdj.Controls.Add(lblPicBrightVal);

            gAdj.Controls.Add(MakeLabel("对比度", 306, 102, 50, 24));
            trkPicContrast = MakeAdjTrack(358, 98, 150);
            gAdj.Controls.Add(trkPicContrast);
            lblPicContrastVal = MakeValLabel(512, 102);
            gAdj.Controls.Add(lblPicContrastVal);

            gAdj.Controls.Add(MakeLabel("饱和度", 566, 102, 50, 24));
            trkPicSat = MakeAdjTrack(618, 98, 150);
            gAdj.Controls.Add(trkPicSat);
            lblPicSatVal = MakeValLabel(772, 102);
            gAdj.Controls.Add(lblPicSatVal);

            gAdj.Controls.Add(MakeHint("0 表示不变，范围约 -1.0 ~ +1.0（拖动滑杆或点值两侧小步进）", 62, 128, 760, 18));

            cmbPicFormat = new ComboBox();
            cmbPicFormat.DropDownStyle = ComboBoxStyle.DropDownList;
            cmbPicFormat.Items.Add("MP4（推荐）");
            cmbPicFormat.Items.Add("MKV（兼容性最强）");
            cmbPicFormat.SelectedIndex = 0;
            cmbPicFormat.SelectedIndexChanged += new EventHandler(delegate(object s, EventArgs e) { SuggestPicOut(); });

            BuildOutputGroup(page, "④ 输出位置", 494,
                "自动命名：保存到视频所在目录（视频名_画面.mp4）",
                ref chkPicSame, ref txtPicOut, ref btnPicOut, cmbPicFormat, null);

            BuildRunArea(page, "⑤ 开始处理", "开始处理", 590,
                ref btnPicStart, ref btnPicStop, ref picProgress, ref lblPicStatus, ref picLog,
                new Func<string>(delegate() { return PickOpenFolder(txtPicOut.Text, txtPicSrc.Text); }), 178);

            btnPicStart.Click -= OnTodo;
            btnPicStart.Click += OnPicStart;
            btnPicStop.Click -= OnTodo;
            btnPicStop.Click += OnStop;
            lblPicStatus.Text = "准备就绪";
            picLog.Text = "";

            // 取样位置去抖计时器
            picFrameTimer = new System.Windows.Forms.Timer();
            picFrameTimer.Interval = 250;
            picFrameTimer.Tick += OnPicFrameTick;

            // 每个调整参数变化 → 右侧预览实时重画
            chkPicRotate.CheckedChanged += OnPicAdjChanged;
            chkPicHFlip.CheckedChanged += OnPicAdjChanged;
            chkPicVFlip.CheckedChanged += OnPicAdjChanged;
            chkPicScale.CheckedChanged += OnPicAdjChanged;
            cmbPicRotate.SelectedIndexChanged += OnPicAdjChanged;
            cmbPicSize.SelectedIndexChanged += OnPicAdjChanged;
            trkPicBright.ValueChanged += OnPicAdjChanged;
            trkPicContrast.ValueChanged += OnPicAdjChanged;
            trkPicSat.ValueChanged += OnPicAdjChanged;
            txtCropTop.TextChanged += OnPicAdjChanged;
            txtCropBottom.TextChanged += OnPicAdjChanged;
            txtCropLeft.TextChanged += OnPicAdjChanged;
            txtCropRight.TextChanged += OnPicAdjChanged;
        }

        // 调色滑杆：-100 ~ +100，映射到 -1.0 ~ +1.0
        private TrackBar MakeAdjTrack(int x, int y, int w)
        {
            TrackBar t = new TrackBar();
            t.Location = new Point(x, y);
            t.Size = new Size(w, 24);
            t.Minimum = -100;
            t.Maximum = 100;
            t.Value = 0;
            t.SmallChange = 5;
            t.LargeChange = 20;
            t.TickStyle = TickStyle.None;
            t.AutoSize = false;
            return t;
        }

        private Label MakeValLabel(int x, int y)
        {
            Label l = new Label();
            l.Text = "0";
            l.Location = new Point(x, y);
            l.Size = new Size(48, 24);
            l.TextAlign = ContentAlignment.MiddleLeft;
            l.ForeColor = CAccent;
            return l;
        }

        // ---------------- 格式转换页 ----------------
        private void BuildConvertPage()
        {
            TabPage page = new TabPage("格式转换");
            page.BackColor = CBg;
            page.Padding = new Padding(0);
            tabs.TabPages.Add(page);
            page.Size = new Size(936, 630);

            BuildSourceGroup(page, "① 选择文件", "源文件",
                "提示：支持视频或音频文件互转，也可导出 GIF 动图（MP4/MKV/MOV/AVI/WEBM/MP3/WAV/FLAC/GIF 等），可直接拖进来",
                ref txtCvSrc, ref btnCvPick, ref lblCvInfo, new EventHandler(OnPickCvSrc));
            txtCvSrc.TextChanged += OnCvSrcChanged;

            GroupBox gConv = MakeGroup("② 转换设置", 10, 128, 916, 176);
            gConv.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
            page.Controls.Add(gConv);

            gConv.Controls.Add(MakeLabel("目标格式", 14, 28, 70, 24));
            cmbCvFormat = MakeCombo(104, 26, 220,
                "MP4（视频，推荐）", "MKV（视频）", "MOV（视频）", "AVI（视频）", "WEBM（视频）",
                "MP3（音频）", "M4A（音频）", "WAV（音频）", "FLAC（音频）", "GIF（动图）");
            cmbCvFormat.SelectedIndexChanged += OnCvFormatChanged;
            gConv.Controls.Add(cmbCvFormat);

            gConv.Controls.Add(MakeLabel("画质", 360, 28, 40, 24));
            cmbCvQuality = MakeCombo(430, 26, 200, "高画质（推荐）", "均衡（体积适中）", "体积最小");
            gConv.Controls.Add(cmbCvQuality);

            gConv.Controls.Add(MakeLabel("分辨率", 14, 68, 70, 24));
            cmbCvScale = MakeCombo(104, 66, 220,
                "保持原样", "1920×1080", "1280×720", "854×480", "640×360");
            gConv.Controls.Add(cmbCvScale);

            gConv.Controls.Add(MakeLabel("音频音质", 360, 68, 70, 24));
            cmbCvAudio = MakeCombo(430, 66, 200,
                "原样（不重新编码）", "AAC 320 kbps", "AAC 192 kbps", "AAC 128 kbps");
            gConv.Controls.Add(cmbCvAudio);

            chkCvFast = new CheckBox();
            chkCvFast.Text = "快速转换（只换封装格式，不重新编码 · 速度最快，要求编码与目标格式兼容）";
            chkCvFast.Location = new Point(14, 106);
            chkCvFast.Size = new Size(700, 24);
            chkCvFast.ForeColor = CText;
            gConv.Controls.Add(chkCvFast);

            gConv.Controls.Add(MakeHint("选 MP3 / M4A / WAV / FLAC 纯音频格式时，自动忽略分辨率、画质等视频选项；选 GIF 动图时无声音，画质档决定帧率（高 15 / 均 12 / 低 8 fps）。", 104, 140, 800, 20));

            BuildOutputGroup(page, "③ 输出位置", 312,
                "自动命名：保存到源文件所在目录（原名_转换.新格式）",
                ref chkCvSame, ref txtCvOut, ref btnCvOut, null, null);

            BuildRunArea(page, "④ 开始转换", "开始转换", 420,
                ref btnCvStart, ref btnCvStop, ref cvProgress, ref lblCvStatus, ref cvLog,
                new Func<string>(delegate() { return PickOpenFolder(txtCvOut.Text, txtCvSrc.Text); }), 198);

            btnCvStart.Click -= OnTodo;
            btnCvStart.Click += OnCvStart;
            btnCvStop.Click -= OnTodo;
            btnCvStop.Click += OnStop;
            lblCvStatus.Text = "准备就绪";
            cvLog.Text = "";
        }

        // ---------------- 新页面事件 ----------------
        // ---------------- 视频下载页 ----------------
        private void BuildDownloadPage()
        {
            TabPage page = new TabPage("视频下载");
            page.BackColor = CBg;
            page.Padding = new Padding(0);
            tabs.TabPages.Add(page);
            page.Size = new Size(936, 630);

            GroupBox gUrl = MakeGroup("① 下载地址", 10, 8, 916, 76);
            gUrl.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
            page.Controls.Add(gUrl);

            gUrl.Controls.Add(MakeLabel("链接地址", 14, 24, 70, 24));
            txtDlUrl = MakeBox(90, 22, 810, 27);
            txtDlUrl.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
            gUrl.Controls.Add(txtDlUrl);

            lblDlHint = MakeHint("支持普通视频链接和 m3u8 地址。m3u8 会自动调用 N_m3u8DL-CLI；普通链接使用 ffmpeg 保存。", 90, 52, 810, 18);
            gUrl.Controls.Add(lblDlHint);

            GroupBox gOpt = MakeGroup("② 下载设置", 10, 90, 916, 122);
            gOpt.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
            page.Controls.Add(gOpt);

            gOpt.Controls.Add(MakeLabel("下载方式", 14, 28, 70, 24));
            cmbDlType = MakeCombo(90, 26, 280,
                "自动识别（推荐）", "m3u8（使用 N_m3u8DL-CLI）", "直接下载（使用 ffmpeg）");
            gOpt.Controls.Add(cmbDlType);
            gOpt.Controls.Add(MakeHint("自动识别：链接含 .m3u8 时走 N_m3u8DL-CLI，否则用 ffmpeg。", 380, 29, 520, 22));

            gOpt.Controls.Add(MakeLabel("保存目录", 14, 62, 70, 24));
            txtDlDir = MakeBox(90, 60, 676, 27);
            txtDlDir.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
            txtDlDir.Text = U.ExeDir();
            gOpt.Controls.Add(txtDlDir);

            btnDlDir = MakeButton("浏览…", 774, 58, 128, 32, false);
            btnDlDir.Anchor = AnchorStyles.Top | AnchorStyles.Right;
            btnDlDir.Click += OnDlPickDir;
            gOpt.Controls.Add(btnDlDir);

            gOpt.Controls.Add(MakeLabel("文件名", 14, 96, 70, 24));
            txtDlName = MakeBox(90, 94, 300, 27);
            txtDlName.Text = "download";
            gOpt.Controls.Add(txtDlName);
            gOpt.Controls.Add(MakeHint("m3u8 保存为「文件名.mp4」；直接下载建议带扩展名（如 .mp4）。", 400, 97, 500, 22));

            GroupBox gRun = MakeGroup("③ 下载与日志", 10, 218, 916, 132);
            gRun.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
            page.Controls.Add(gRun);

            btnDlStart = MakeButton("开始下载", 14, 20, 120, 32, true);
            btnDlStart.Click += OnDlStart;
            gRun.Controls.Add(btnDlStart);

            btnDlStop = MakeButton("停止", 140, 20, 80, 32, false);
            btnDlStop.Enabled = false;
            btnDlStop.Click += OnStop;
            gRun.Controls.Add(btnDlStop);

            btnDlOpen = MakeButton("打开下载目录", 226, 20, 120, 32, false);
            btnDlOpen.Click += new EventHandler(delegate(object s, EventArgs e)
            {
                string d = txtDlDir == null ? "" : txtDlDir.Text.Trim();
                if (d.Length > 0 && Directory.Exists(d)) OpenFolder(d);
                else MessageBox.Show(this, "下载目录不存在。", "提示", MessageBoxButtons.OK, MessageBoxIcon.Information);
            });
            gRun.Controls.Add(btnDlOpen);

            btnFindM3u8 = MakeButton("指定 N_m3u8DL", 352, 20, 132, 32, false);
            btnFindM3u8.Visible = false;
            btnFindM3u8.Click += OnFindM3u8;
            gRun.Controls.Add(btnFindM3u8);

            lblDlStatus = MakeLabel("准备就绪", 492, 22, 408, 26);
            lblDlStatus.Anchor = AnchorStyles.Top | AnchorStyles.Right;
            lblDlStatus.TextAlign = ContentAlignment.MiddleRight;
            lblDlStatus.Font = fBold;
            lblDlStatus.ForeColor = CText;
            gRun.Controls.Add(lblDlStatus);

            dlProgress = new ProgressBar();
            dlProgress.Location = new Point(14, 58);
            dlProgress.Size = new Size(886, 14);
            dlProgress.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
            dlProgress.Minimum = 0;
            dlProgress.Maximum = 100;
            gRun.Controls.Add(dlProgress);

            dlLog = MakeRunLog();
            dlLog.Location = new Point(14, 76);
            dlLog.Size = new Size(886, 48);
            dlLog.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
            gRun.Controls.Add(dlLog);

            GroupBox gHist = MakeGroup("④ 下载记录", 10, 356, 916, 266);
            gHist.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right | AnchorStyles.Bottom;
            page.Controls.Add(gHist);

            Button btnDlRetry = MakeButton("重新下载", 14, 20, 96, 28, false);
            btnDlRetry.Click += OnDlRetry;
            gHist.Controls.Add(btnDlRetry);

            Button btnDlOpenFile = MakeButton("打开文件", 116, 20, 90, 28, false);
            btnDlOpenFile.Click += OnDlOpenFile;
            gHist.Controls.Add(btnDlOpenFile);

            Button btnDlOpenDir2 = MakeButton("打开所在目录", 212, 20, 110, 28, false);
            btnDlOpenDir2.Click += OnDlOpenFolder;
            gHist.Controls.Add(btnDlOpenDir2);

            Button btnDlCopy = MakeButton("复制链接", 328, 20, 90, 28, false);
            btnDlCopy.Click += OnDlCopyUrl;
            gHist.Controls.Add(btnDlCopy);

            Button btnDlRemove = MakeButton("删除记录", 424, 20, 90, 28, false);
            btnDlRemove.Click += OnDlRemove;
            gHist.Controls.Add(btnDlRemove);

            Button btnDlClear = MakeButton("清空已完成", 520, 20, 100, 28, false);
            btnDlClear.Click += OnDlClearDone;
            gHist.Controls.Add(btnDlClear);

            lvDlHistory = new ListView();
            lvDlHistory.Location = new Point(14, 54);
            lvDlHistory.Size = new Size(886, 204);
            lvDlHistory.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right | AnchorStyles.Bottom;
            lvDlHistory.View = View.Details;
            lvDlHistory.FullRowSelect = true;
            lvDlHistory.GridLines = false;
            lvDlHistory.MultiSelect = false;
            lvDlHistory.HideSelection = false;
            lvDlHistory.BorderStyle = BorderStyle.FixedSingle;
            lvDlHistory.Columns.Add("时间", 132, HorizontalAlignment.Left);
            lvDlHistory.Columns.Add("文件名", 170, HorizontalAlignment.Left);
            lvDlHistory.Columns.Add("方式", 64, HorizontalAlignment.Center);
            lvDlHistory.Columns.Add("状态", 82, HorizontalAlignment.Center);
            lvDlHistory.Columns.Add("大小", 84, HorizontalAlignment.Right);
            lvDlHistory.Columns.Add("保存位置 / 链接", -2, HorizontalAlignment.Left);
            lvDlHistory.DoubleClick += OnDlHistoryDoubleClick;

            ContextMenuStrip cms = new ContextMenuStrip();
            ToolStripMenuItem miOpen = new ToolStripMenuItem("打开文件");
            miOpen.Click += OnDlOpenFile;
            cms.Items.Add(miOpen);
            ToolStripMenuItem miDir = new ToolStripMenuItem("打开所在目录");
            miDir.Click += OnDlOpenFolder;
            cms.Items.Add(miDir);
            ToolStripMenuItem miCopy = new ToolStripMenuItem("复制链接");
            miCopy.Click += OnDlCopyUrl;
            cms.Items.Add(miCopy);
            cms.Items.Add(new ToolStripSeparator());
            ToolStripMenuItem miRetry = new ToolStripMenuItem("重新下载");
            miRetry.Click += OnDlRetry;
            cms.Items.Add(miRetry);
            ToolStripMenuItem miDel = new ToolStripMenuItem("删除记录");
            miDel.Click += OnDlRemove;
            cms.Items.Add(miDel);
            lvDlHistory.ContextMenuStrip = cms;
            gHist.Controls.Add(lvDlHistory);
        }

        private void OnDlPickDir(object sender, EventArgs e)
        {
            FolderBrowserDialog d = new FolderBrowserDialog();
            d.Description = "选择下载保存目录";
            string cur = txtDlDir.Text.Trim();
            if (cur.Length > 0 && Directory.Exists(cur)) d.SelectedPath = cur;
            if (d.ShowDialog(this) == DialogResult.OK) txtDlDir.Text = d.SelectedPath;
        }

        private static bool IsM3u8Url(string url)
        {
            if (string.IsNullOrEmpty(url)) return false;
            return url.IndexOf(".m3u8", StringComparison.OrdinalIgnoreCase) >= 0
                || url.IndexOf("format=m3u8", StringComparison.OrdinalIgnoreCase) >= 0
                || url.IndexOf("/m3u8", StringComparison.OrdinalIgnoreCase) >= 0;
        }

        // ---------------- 下载记录管理 ----------------
        private static string DlNow()
        {
            return DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss");
        }

        private void LoadDlHistoryUi()
        {
            try
            {
                dlRecords = DownloadHistory.Load();
                if (lvDlHistory == null) return;
                lvDlHistory.BeginUpdate();
                lvDlHistory.Items.Clear();
                foreach (DownloadRecord r in dlRecords)
                {
                    r.Row = MakeDlRow(r);
                    lvDlHistory.Items.Add(r.Row);
                }
                lvDlHistory.EndUpdate();
            }
            catch { }
        }

        private void SaveDlHistoryUi()
        {
            try { DownloadHistory.Save(dlRecords); } catch { }
        }

        private ListViewItem MakeDlRow(DownloadRecord r)
        {
            ListViewItem it = new ListViewItem(string.IsNullOrEmpty(r.CreatedAt) ? "" : r.CreatedAt);
            it.SubItems.Add(string.IsNullOrEmpty(r.FileName) ? Path.GetFileName(r.OutputPath) : r.FileName);
            it.SubItems.Add(r.Mode == "m3u8" ? "m3u8" : "直链");
            it.SubItems.Add(string.IsNullOrEmpty(r.Status) ? "" : r.Status);
            it.SubItems.Add(r.Size > 0 ? U.FmtSize(r.Size) : "");
            string loc = !string.IsNullOrEmpty(r.OutputPath) ? r.OutputPath : r.Url;
            it.SubItems.Add(loc);
            it.Tag = r;
            ColorizeDlRow(it, r.Status);
            return it;
        }

        private void ColorizeDlRow(ListViewItem it, string status)
        {
            if (it == null) return;
            if (status == "完成") it.ForeColor = COk;
            else if (status == "失败") it.ForeColor = CErr;
            else if (status == "已停止") it.ForeColor = CMuted;
            else if (status == "下载中") it.ForeColor = CAccent;
            else it.ForeColor = CText;
        }

        private void UpdateDlRow(DownloadRecord r)
        {
            if (r == null) return;
            try
            {
                if (r.Row == null || lvDlHistory == null || lvDlHistory.Items.IndexOf(r.Row) < 0)
                {
                    if (lvDlHistory != null)
                    {
                        r.Row = MakeDlRow(r);
                        lvDlHistory.Items.Insert(0, r.Row);
                    }
                    return;
                }
                r.Row.SubItems[0].Text = string.IsNullOrEmpty(r.CreatedAt) ? "" : r.CreatedAt;
                r.Row.SubItems[1].Text = string.IsNullOrEmpty(r.FileName) ? Path.GetFileName(r.OutputPath) : r.FileName;
                r.Row.SubItems[2].Text = r.Mode == "m3u8" ? "m3u8" : "直链";
                r.Row.SubItems[3].Text = string.IsNullOrEmpty(r.Status) ? "" : r.Status;
                r.Row.SubItems[4].Text = r.Size > 0 ? U.FmtSize(r.Size) : "";
                r.Row.SubItems[5].Text = !string.IsNullOrEmpty(r.OutputPath) ? r.OutputPath : r.Url;
                ColorizeDlRow(r.Row, r.Status);
            }
            catch { }
        }

        private void AddDlRecord(DownloadRecord r)
        {
            if (r == null) return;
            dlRecords.Insert(0, r);
            if (lvDlHistory != null)
            {
                r.Row = MakeDlRow(r);
                lvDlHistory.Items.Insert(0, r.Row);
                r.Row.Selected = true;
                r.Row.EnsureVisible();
            }
            SaveDlHistoryUi();
        }

        private DownloadRecord GetSelDl()
        {
            if (lvDlHistory == null || lvDlHistory.SelectedItems.Count == 0) return null;
            return lvDlHistory.SelectedItems[0].Tag as DownloadRecord;
        }

        private void OnDlRetry(object sender, EventArgs e)
        {
            DownloadRecord r = GetSelDl();
            if (r == null) return;
            if (running || batchRunning)
            {
                MessageBox.Show(this, "当前有任务正在运行，请稍后再试。", "提示", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            txtDlUrl.Text = r.Url;
            if (!string.IsNullOrEmpty(r.SaveDir)) txtDlDir.Text = r.SaveDir;
            if (!string.IsNullOrEmpty(r.FileName)) txtDlName.Text = Path.GetFileNameWithoutExtension(r.FileName);
            if (r.Mode == "m3u8") cmbDlType.SelectedIndex = 1;
            else if (r.Mode == "ffmpeg") cmbDlType.SelectedIndex = 2;
            OnDlStart(null, EventArgs.Empty);
        }

        private void OnDlOpenFile(object sender, EventArgs e)
        {
            DownloadRecord r = GetSelDl();
            if (r == null) return;
            string p = r.OutputPath;
            if (string.IsNullOrEmpty(p) || !File.Exists(p))
            {
                MessageBox.Show(this, "文件不存在：" + p, "提示", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            try { Process.Start(p); } catch (Exception ex) { MessageBox.Show(this, "无法打开文件：" + ex.Message, "提示", MessageBoxButtons.OK, MessageBoxIcon.Warning); }
        }

        private void OnDlOpenFolder(object sender, EventArgs e)
        {
            DownloadRecord r = GetSelDl();
            if (r == null) return;
            string p = r.OutputPath;
            if (!string.IsNullOrEmpty(p) && File.Exists(p))
            {
                try { Process.Start("explorer.exe", "/select," + U.Q(p)); } catch { OpenFolder(Path.GetDirectoryName(p)); }
                return;
            }
            string d = !string.IsNullOrEmpty(r.SaveDir) ? r.SaveDir : Path.GetDirectoryName(p);
            if (!string.IsNullOrEmpty(d) && Directory.Exists(d)) OpenFolder(d);
            else MessageBox.Show(this, "目录不存在。", "提示", MessageBoxButtons.OK, MessageBoxIcon.Information);
        }

        private void OnDlCopyUrl(object sender, EventArgs e)
        {
            DownloadRecord r = GetSelDl();
            if (r == null || string.IsNullOrEmpty(r.Url)) return;
            try { Clipboard.SetText(r.Url); AppendLog("已复制下载链接"); } catch { }
        }

        private void OnDlRemove(object sender, EventArgs e)
        {
            DownloadRecord r = GetSelDl();
            if (r == null) return;
            if (r == currentDlRecord && running)
            {
                MessageBox.Show(this, "该任务正在下载，不能删除记录。", "提示", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            if (r.Row != null) lvDlHistory.Items.Remove(r.Row);
            dlRecords.Remove(r);
            if (r == currentDlRecord) currentDlRecord = null;
            SaveDlHistoryUi();
        }

        private void OnDlClearDone(object sender, EventArgs e)
        {
            List<DownloadRecord> keep = new List<DownloadRecord>();
            foreach (DownloadRecord r in dlRecords)
            {
                if (r.Status == "完成" || r.Status == "失败" || r.Status == "已停止") continue;
                keep.Add(r);
            }
            dlRecords = keep;
            LoadDlHistoryUiFromList();
            SaveDlHistoryUi();
        }

        private void LoadDlHistoryUiFromList()
        {
            if (lvDlHistory == null) return;
            lvDlHistory.BeginUpdate();
            lvDlHistory.Items.Clear();
            foreach (DownloadRecord r in dlRecords)
            {
                r.Row = MakeDlRow(r);
                lvDlHistory.Items.Add(r.Row);
            }
            lvDlHistory.EndUpdate();
        }

        private void OnDlHistoryDoubleClick(object sender, EventArgs e)
        {
            DownloadRecord r = GetSelDl();
            if (r == null) return;
            if (r.Status == "完成" && !string.IsNullOrEmpty(r.OutputPath) && File.Exists(r.OutputPath))
                OnDlOpenFile(sender, e);
            else
                OnDlOpenFolder(sender, e);
        }

        private void OnDlStart(object sender, EventArgs e)
        {
            if (batchRunning)
            {
                MessageBox.Show(this, "正在批量合并，请等它结束后再下载。", "提示", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            if (running)
            {
                MessageBox.Show(this, "上一个任务还在进行，请等它结束或点停止。", "提示", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }

            string url = txtDlUrl.Text.Trim();
            if (url.Length == 0)
            {
                MessageBox.Show(this, "请先输入下载链接。", "提示", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }
            if (!(url.StartsWith("http://", StringComparison.OrdinalIgnoreCase) || url.StartsWith("https://", StringComparison.OrdinalIgnoreCase)))
            {
                MessageBox.Show(this, "目前只支持 http/https 链接。", "提示", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }

            string dir = txtDlDir.Text.Trim();
            if (dir.Length == 0) dir = U.ExeDir();
            try { dir = Path.GetFullPath(dir); } catch { }
            if (!Directory.Exists(dir))
            {
                try { Directory.CreateDirectory(dir); }
                catch (Exception ex)
                {
                    MessageBox.Show(this, "无法创建保存目录：" + ex.Message, "提示", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                    return;
                }
            }

            string name = txtDlName.Text.Trim();
            if (name.Length == 0) name = "download";
            foreach (char c in Path.GetInvalidFileNameChars()) name = name.Replace(c, '_');

            int type = cmbDlType.SelectedIndex; if (type < 0) type = 0;
            bool useM3u8 = (type == 1) || (type == 0 && IsM3u8Url(url));

            string args = "";
            string outPath = "";
            string mode = useM3u8 ? "m3u8" : "ffmpeg";
            string exe = "";

            if (useM3u8)
            {
                if (!M3u8DL.Ready) M3u8DL.Detect();
                if (!M3u8DL.Ready)
                {
                    if (btnFindM3u8 != null) btnFindM3u8.Visible = true;
                    MessageBox.Show(this, "未找到 N_m3u8DL-CLI。请点击「指定 N_m3u8DL」手动选择程序位置，或将其放到程序目录、lib 子目录中后重试。", "缺少下载器", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                    return;
                }

                string saveName = Path.GetFileNameWithoutExtension(name);
                if (string.IsNullOrEmpty(saveName)) saveName = "download";
                outPath = U.UniquePath(dir, saveName, ".mp4");
                saveName = Path.GetFileNameWithoutExtension(outPath);

                StringBuilder sb = new StringBuilder();
                sb.Append(U.Q(url) + " ");
                sb.Append("--workDir " + U.Q(dir) + " ");
                sb.Append("--saveName " + U.Q(saveName) + " ");
                sb.Append("--enableDelAfterDone");
                args = sb.ToString();
                exe = M3u8DL.ExePath;

                AppendLog("—— m3u8 下载：" + url);
            }
            else
            {
                if (!Ffmpeg.Ready)
                {
                    MessageBox.Show(this, "还没有可用的 ffmpeg。直接下载需要 ffmpeg，请先在合并模式指定 ffmpeg。", "缺少 ffmpeg", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                    btnFindFfmpeg.Visible = true;
                    return;
                }

                string fileName = name;
                if (Path.GetExtension(fileName).Length == 0) fileName += ".mp4";
                string ext = Path.GetExtension(fileName);
                if (string.IsNullOrEmpty(ext)) ext = ".mp4";
                string baseName = Path.GetFileNameWithoutExtension(fileName);
                outPath = U.UniquePath(dir, baseName, ext);

                StringBuilder sb = new StringBuilder();
                sb.Append("-hide_banner -nostats -y ");
                sb.Append("-i " + U.Q(url) + " ");
                sb.Append("-c copy ");
                sb.Append("-progress pipe:1 -loglevel info ");
                sb.Append(U.Q(outPath));
                args = sb.ToString();

                AppendLog("—— 直接下载：" + url);
            }

            AppendLog("保存到：" + outPath);

            DownloadRecord rec = new DownloadRecord();
            rec.Id = Guid.NewGuid().ToString("N");
            rec.Url = url;
            rec.FileName = Path.GetFileName(outPath);
            rec.SaveDir = dir;
            rec.OutputPath = outPath;
            rec.Mode = mode;
            rec.Status = "下载中";
            rec.CreatedAt = DlNow();
            currentDlRecord = rec;
            AddDlRecord(rec);

            Job job = new Job();
            job.Kind = 6;
            job.Output = outPath;
            job.Exe = exe;
            job.VideoDuration = 0;

            btnDlStart.Enabled = false;
            btnDlStop.Enabled = true;
            StartFfmpegJob(args, job, new Action<JobResult>(OnDlDone), dlProgress, "下载中…");
        }

        private void OnDlDone(JobResult r)
        {
            DownloadRecord rec = currentDlRecord;
            if (r.Ok)
            {
                lblDlStatus.Text = "下载完成 ✓";
                AppendLog("完成：输出 " + U.FmtSize(r.Size) + (r.Duration > 0 ? "，时长 " + U.FmtTime(r.Duration) : ""));
                if (currentJob != null) AppendLog("文件已保存：" + currentJob.Output);
                if (rec != null)
                {
                    rec.Status = "完成";
                    rec.Size = r.Size;
                    rec.Duration = r.Duration;
                    if (currentJob != null && !string.IsNullOrEmpty(currentJob.Output)) rec.OutputPath = currentJob.Output;
                    rec.FileName = Path.GetFileName(rec.OutputPath);
                    rec.FinishedAt = DlNow();
                    rec.Message = "";
                }
            }
            else if (r.Stopped)
            {
                lblDlStatus.Text = "已停止";
                if (rec != null)
                {
                    rec.Status = "已停止";
                    rec.FinishedAt = DlNow();
                    rec.Message = "用户已停止";
                }
            }
            else
            {
                lblDlStatus.Text = "下载失败";
                AppendLog("[失败] " + r.Message);
                string hint = HintForFailure(r.Details);
                if (hint.Length > 0) AppendLog("[建议] " + hint);
                if (currentJob != null && currentJob.Exe != null && currentJob.Exe.Length > 0)
                    AppendLog("[提示] m3u8 下载失败时，可确认链接可访问、是否需要 Referer/Cookie，或尝试复制链接到浏览器检查。");
                if (rec != null)
                {
                    rec.Status = "失败";
                    rec.FinishedAt = DlNow();
                    rec.Message = r.Message != null ? r.Message : "";
                }
            }
            if (rec != null) UpdateDlRow(rec);
            currentDlRecord = null;
            SaveDlHistoryUi();
            btnDlStart.Enabled = true;
            btnDlStop.Enabled = false;
        }

        private void OnTodo(object sender, EventArgs e)
        {
            MessageBox.Show(this,
                "该功能界面已就绪，处理逻辑正在开发中，敬请期待！\n\n当前版本可正常使用：音视频合并（单个 / 批量）、音频提取、视频剪辑、视频拼接、画面调整、格式转换、视频下载。",
                "功能开发中", MessageBoxButtons.OK, MessageBoxIcon.Information);
        }

        private void OnDropToBox(object sender, DragEventArgs e)
        {
            if (!e.Data.GetDataPresent(DataFormats.FileDrop)) return;
            string[] items = (string[])e.Data.GetData(DataFormats.FileDrop);
            if (items == null || items.Length == 0) return;
            foreach (string p in items)
            {
                TextBox t = sender as TextBox;
                if (t != null && File.Exists(p)) { t.Text = p; break; }
            }
        }

        private void OnDropToList(object sender, DragEventArgs e)
        {
            if (!e.Data.GetDataPresent(DataFormats.FileDrop)) return;
            string[] items = (string[])e.Data.GetData(DataFormats.FileDrop);
            if (items == null || items.Length == 0) return;
            List<string> vids = new List<string>();
            foreach (string p in items) if (File.Exists(p) && U.IsVideo(p)) vids.Add(p);
            if (vids.Count > 0) AddClips(vids);
        }

        private void OnPickVideoFileOpen(TextBox target)
        {
            OpenFileDialog d = new OpenFileDialog();
            d.Title = "选择视频文件";
            d.Filter = "视频文件|*.mp4;*.mkv;*.mov;*.flv;*.avi;*.webm;*.ts;*.m4v;*.wmv;*.mpg;*.mpeg;*.3gp|所有文件|*.*";
            if (d.ShowDialog(this) == DialogResult.OK && target != null) target.Text = d.FileName;
        }

        private void OnPickExSrc(object sender, EventArgs e) { OnPickVideoFileOpen(txtExSrc); }
        private void OnPickPicSrc(object sender, EventArgs e) { OnPickVideoFileOpen(txtPicSrc); }

        private void OnPickCvSrc(object sender, EventArgs e)
        {
            OpenFileDialog d = new OpenFileDialog();
            d.Title = "选择要转换的文件";
            d.Filter = "媒体文件|*.mp4;*.mkv;*.mov;*.avi;*.webm;*.flv;*.ts;*.m4v;*.wmv;*.mpg;*.mpeg;*.3gp;*.mp3;*.m4a;*.aac;*.wav;*.flac;*.ogg;*.opus;*.wma;*.gif|所有文件|*.*";
            if (d.ShowDialog(this) == DialogResult.OK) txtCvSrc.Text = d.FileName;
        }

        private void OnPickClipAdd(object sender, EventArgs e)
        {
            OpenFileDialog d = new OpenFileDialog();
            d.Title = "添加视频片段";
            d.Filter = "视频文件|*.mp4;*.mkv;*.mov;*.flv;*.avi;*.webm;*.ts;*.m4v;*.wmv;*.mpg;*.mpeg;*.3gp|所有文件|*.*";
            d.Multiselect = true;
            if (d.ShowDialog(this) == DialogResult.OK && d.FileNames.Length > 0) AddClips(new List<string>(d.FileNames));
        }

        private void AddClips(List<string> paths)
        {
            if (lstClips == null) return;
            foreach (string p in paths)
            {
                string full;
                try { full = Path.GetFullPath(p); }
                catch { continue; }
                bool dup = false;
                foreach (object it in lstClips.Items)
                {
                    if (string.Equals((string)it, full, StringComparison.OrdinalIgnoreCase)) { dup = true; break; }
                }
                if (!dup) lstClips.Items.Add(full);
            }
            if (lstClips.Items.Count > 0) lstClips.SelectedIndex = 0;
            SuggestClipOut(false);
        }

        private void OnClipRemove(object sender, EventArgs e)
        {
            int i = lstClips.SelectedIndex;
            if (i >= 0) lstClips.Items.RemoveAt(i);
        }

        private void OnClipUp(object sender, EventArgs e)
        {
            int i = lstClips.SelectedIndex;
            if (i > 0)
            {
                object o = lstClips.Items[i];
                lstClips.Items.Remove(o);
                lstClips.Items.Insert(i - 1, o);
                lstClips.SelectedIndex = i - 1;
            }
        }

        private void OnClipDown(object sender, EventArgs e)
        {
            int i = lstClips.SelectedIndex;
            if (i >= 0 && i < lstClips.Items.Count - 1)
            {
                object o = lstClips.Items[i];
                lstClips.Items.Remove(o);
                lstClips.Items.Insert(i + 1, o);
                lstClips.SelectedIndex = i + 1;
            }
        }

        private void OnClipClear(object sender, EventArgs e)
        {
            lstClips.Items.Clear();
            txtClipOut.Text = "";
        }

        private void OnClipFormatChanged(object sender, EventArgs e)
        {
            string cur = txtClipOut.Text.Trim();
            if (cur.Length > 0)
            {
                string target = Path.ChangeExtension(cur, cmbClipFormat.SelectedIndex == 1 ? ".mkv" : ".mp4");
                txtClipOut.Text = target;
            }
        }

        // ---------------- 视频剪辑 ----------------

        private void OnPickCutSrc(object sender, EventArgs e) { OnPickVideoFileOpen(txtCutSrc); }

        // 支持 秒 / 分:秒 / 时:分:秒，可带小数；返回 -1 表示格式错误或留空
        private static double ParseTime(string s)
        {
            if (s == null) return -1;
            s = s.Trim().Replace("：", ":").Replace("，", ".");
            if (s.Length == 0) return -1;
            string[] parts = s.Split(':');
            double total = 0;
            foreach (string p in parts)
            {
                double v;
                if (p.Length == 0 || !double.TryParse(p, out v) || v < 0) return -1;
                total = total * 60 + v;
            }
            return total;
        }

        private void OnCutSrcChanged(object sender, EventArgs e)
        {
            string src = txtCutSrc.Text.Trim();
            SuggestCutOut();
            ProbeInfoLabel(src, lblCutInfo);

            // 换视频：作废旧任务，清空预览与缩略图
            cutSrcDur = 0;
            cutToken++;
            cutPrevToken++;
            pendingPreviewPos = -1;
            ClearCutTempDir();
            ClearCutVisuals();

            bool ok = src.Length > 0 && File.Exists(src) && Ffmpeg.ProbeReady;
            if (ok)
            {
                try { cutSrcDur = Media.Probe(src, true).Duration; }
                catch { cutSrcDur = 0; }
            }
            bool hasVideo = cutSrcDur > 0;

            cutSlider.SetDuration(cutSrcDur);
            cutSync = true;
            txtCutStart.Text = hasVideo ? "00:00" : "";
            txtCutEnd.Text = "";
            cutSync = false;
            SetCutPosLabel(0);
            lblCutDurHint.Text = hasVideo
                ? "视频总时长 " + U.FmtTime(cutSrcDur) + " · 点击滑块定位画面，拖动两端白色把手选择区间"
                : (src.Length > 0 && File.Exists(src) ? "没有读到视频总时长，也可以直接填写起止时间。" : "");
            if (hasVideo) StartCutThumbs(src);
        }

        private void OnCutTimeChanged(object sender, EventArgs e)
        {
            UpdateCutDurHint();
            if (cutSync || cutSlider == null) return;
            if (cutSrcDur <= 0) return;

            double s = ParseTime(txtCutStart.Text);
            if (s < 0) s = 0;
            double e2 = ParseTime(txtCutEnd.Text);
            if (e2 < 0) e2 = cutSrcDur;
            cutSync = true;
            cutSlider.SetValues(s, e2, cutSlider.CurPos, false);
            cutSync = false;
        }

        private void UpdateCutDurHint()
        {
            if (lblCutDurHint == null) return;
            string src = txtCutSrc.Text.Trim();
            if (src.Length == 0 || !File.Exists(src)) { lblCutDurHint.Text = ""; return; }
            if (cutSrcDur <= 0) { lblCutDurHint.Text = "没有读到视频总时长，也可以直接填写起止时间。"; return; }

            double s = ParseTime(txtCutStart.Text);
            double e = ParseTime(txtCutEnd.Text);
            if (e < 0) e = cutSrcDur;
            if (s < 0)
            {
                lblCutDurHint.Text = "视频总时长 " + U.FmtTime(cutSrcDur);
                return;
            }
            if (s >= cutSrcDur)
            {
                lblCutDurHint.Text = "[注意] 开始时间已超过视频总时长 " + U.FmtTime(cutSrcDur);
                return;
            }
            if (e > cutSrcDur) e = cutSrcDur;
            if (e - s <= 0)
            {
                lblCutDurHint.Text = "[注意] 结束时间需要晚于开始时间";
                return;
            }
            lblCutDurHint.Text = "视频总时长 " + U.FmtTime(cutSrcDur)
                + " · 将截取 " + U.FmtTime(e - s) + "（" + U.FmtTime(s) + " → " + U.FmtTime(e) + "）";
        }

        private void SuggestCutOut()
        {
            string src = txtCutSrc.Text.Trim();
            if (src.Length == 0 || !File.Exists(src)) return;
            if (!chkCutSame.Checked) return;
            string dir = Path.GetDirectoryName(src);
            if (string.IsNullOrEmpty(dir)) dir = U.ExeDir();
            string ext = (cmbCutFormat != null && cmbCutFormat.SelectedIndex == 1) ? ".mkv" : ".mp4";
            txtCutOut.Text = U.UniquePath(dir, Path.GetFileNameWithoutExtension(src) + "_剪辑", ext);
        }

        private void OnCutStart(object sender, EventArgs e)
        {
            if (batchRunning)
            {
                MessageBox.Show(this, "正在批量合并，请等它结束后再剪辑。", "提示", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            if (running)
            {
                MessageBox.Show(this, "上一个任务还在进行，请等它结束或点停止。", "提示", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            if (!Ffmpeg.Ready)
            {
                MessageBox.Show(this, "还没有可用的 ffmpeg。请切到合并模式点「指定 ffmpeg」。", "缺少 ffmpeg", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                btnFindFfmpeg.Visible = true;
                return;
            }

            string src = txtCutSrc.Text.Trim();
            if (src.Length == 0 || !File.Exists(src))
            {
                MessageBox.Show(this, "请先选择存在的视频文件。", "提示", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }

            string s0 = txtCutStart.Text.Trim();
            double start = 0;
            if (s0.Length > 0)
            {
                start = ParseTime(s0);
                if (start < 0)
                {
                    MessageBox.Show(this, "开始时间格式不对，请写成 00:00:00 或 00:00 这种形式。", "提示", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                    return;
                }
            }

            string s1 = txtCutEnd.Text.Trim();
            double end = -1;
            if (s1.Length > 0)
            {
                end = ParseTime(s1);
                if (end < 0)
                {
                    MessageBox.Show(this, "结束时间格式不对，请写成 00:00:00 或 00:00 这种形式，或者留空表示剪到结尾。", "提示", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                    return;
                }
            }

            if (cutSrcDur <= 0 && Ffmpeg.ProbeReady)
            {
                try { cutSrcDur = Media.Probe(src, true).Duration; } catch { }
            }
            if (end < 0) end = cutSrcDur;
            if (cutSrcDur > 0 && start >= cutSrcDur - 0.05)
            {
                MessageBox.Show(this, "开始时间已超过视频结尾（总时长 " + U.FmtTime(cutSrcDur) + "）。", "提示", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }
            if (cutSrcDur > 0 && end > cutSrcDur)
            {
                end = cutSrcDur;
                AppendLog("[提示] 结束时间超出视频总长，已按视频结尾处理。");
            }
            if (end > 0 && end <= start)
            {
                MessageBox.Show(this, "结束时间必须晚于开始时间。", "提示", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }
            double dur = end > 0 ? end - start : 0;

            if (txtCutOut.Text.Trim().Length == 0) SuggestCutOut();
            string outRaw = txtCutOut.Text.Trim();
            if (outRaw.Length == 0)
            {
                MessageBox.Show(this, "请指定输出文件。", "提示", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }

            string ext = cmbCutFormat.SelectedIndex == 1 ? "mkv" : "mp4";
            string fullOut = Path.GetFullPath(outRaw);
            string outDir = Path.GetDirectoryName(fullOut);
            if (outDir == null || !Directory.Exists(outDir))
            {
                MessageBox.Show(this, "输出文件夹不存在：" + outDir, "提示", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }
            if (string.Equals(fullOut, Path.GetFullPath(src), StringComparison.OrdinalIgnoreCase))
            {
                MessageBox.Show(this, "输出文件不能和源文件是同一个，否则会覆盖原始文件。请换个输出文件名。", "提示", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }
            if (U.Ext(fullOut) != ext)
            {
                fullOut = Path.ChangeExtension(fullOut, "." + ext);
                AppendLog("[提示] 输出扩展名已按所选格式改为 ." + ext + "，保存为 " + Path.GetFileName(fullOut));
            }

            bool fast = rdoCutFast.Checked;
            StringBuilder sb = new StringBuilder();
            sb.Append("-hide_banner -nostats -y ");
            sb.Append("-ss " + start.ToString("0.###", System.Globalization.CultureInfo.InvariantCulture) + " ");
            sb.Append("-i " + U.Q(src) + " ");
            if (dur > 0) sb.Append("-t " + dur.ToString("0.###", System.Globalization.CultureInfo.InvariantCulture) + " ");
            sb.Append("-map 0:v:0 -map 0:a:0? ");
            if (fast) sb.Append("-c copy -avoid_negative_ts make_zero ");
            else sb.Append("-c:v libx264 -preset veryfast -crf 20 -pix_fmt yuv420p -c:a aac -b:a 192k ");
            if (ext == "mp4") sb.Append("-movflags +faststart ");
            sb.Append("-max_muxing_queue_size 4096 ");
            sb.Append("-progress pipe:1 ");
            sb.Append("-loglevel info ");
            sb.Append(U.Q(fullOut));

            Job job = new Job();
            job.Kind = 2;
            job.Video = src;
            job.Output = fullOut;
            job.VideoDuration = dur > 0 ? dur : cutSrcDur;

            AppendLog("—— 剪辑：" + Path.GetFileName(src) + "（" + U.FmtTime(start) + " → "
                + (end > 0 ? U.FmtTime(end) : "结尾") + "，"
                + (fast ? "快速剪裁" : "精确剪裁") + "）");

            StartFfmpegJob(sb.ToString(), job, new Action<JobResult>(OnCutDone), cutProgress, "剪辑中…");
        }

        private void OnCutDone(JobResult r)
        {
            if (r.Ok)
            {
                lblCutStatus.Text = "剪辑完成 ✓";
                AppendLog("完成：输出 " + U.FmtSize(r.Size) + "，时长 " + U.FmtTime(r.Duration));
                if (currentJob != null) AppendLog("文件已保存：" + currentJob.Output);
            }
            else if (r.Stopped)
            {
                lblCutStatus.Text = "已停止";
            }
            else
            {
                lblCutStatus.Text = "剪辑失败";
                AppendLog("[失败] " + r.Message);
                string hint = HintForFailure(r.Details);
                if (hint.Length > 0) AppendLog("[建议] " + hint);
            }
        }

        // ---------------- 视频拼接 ----------------

        private void OnJoinStart(object sender, EventArgs e)
        {
            if (batchRunning)
            {
                MessageBox.Show(this, "正在批量合并，请等它结束后再拼接。", "提示", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            if (running)
            {
                MessageBox.Show(this, "上一个任务还在进行，请等它结束或点停止。", "提示", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            if (!Ffmpeg.Ready)
            {
                MessageBox.Show(this, "还没有可用的 ffmpeg。请切到合并模式点「指定 ffmpeg」。", "缺少 ffmpeg", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                btnFindFfmpeg.Visible = true;
                return;
            }

            List<string> clips = new List<string>();
            foreach (object it in lstClips.Items)
            {
                string p = (string)it;
                if (File.Exists(p)) clips.Add(p);
            }
            if (clips.Count < 2)
            {
                MessageBox.Show(this, "请在素材列表里加入至少 2 个视频片段。只截取单段请用「视频剪辑」页。", "提示", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }

            if (txtClipOut.Text.Trim().Length == 0) SuggestClipOut(true);
            string outRaw = txtClipOut.Text.Trim();
            if (outRaw.Length == 0)
            {
                MessageBox.Show(this, "请指定输出文件。", "提示", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }

            string ext = cmbClipFormat.SelectedIndex == 1 ? "mkv" : "mp4";
            string fullOut = Path.GetFullPath(outRaw);
            string outDir = Path.GetDirectoryName(fullOut);
            if (outDir == null || !Directory.Exists(outDir))
            {
                MessageBox.Show(this, "输出文件夹不存在：" + outDir, "提示", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }
            bool sameSrc = false;
            foreach (string c in clips)
            {
                if (string.Equals(fullOut, Path.GetFullPath(c), StringComparison.OrdinalIgnoreCase)) { sameSrc = true; break; }
            }
            if (sameSrc)
            {
                MessageBox.Show(this, "输出文件不能和某个片段是同一个文件，否则会覆盖原始片段。请换个输出文件名。", "提示", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }
            if (U.Ext(fullOut) != ext)
            {
                fullOut = Path.ChangeExtension(fullOut, "." + ext);
                AppendLog("[提示] 输出扩展名已按所选格式改为 ." + ext + "，保存为 " + Path.GetFileName(fullOut));
            }

            bool encode = rdoJoinEncode.Checked;

            // 探测各片段流参数（编码 / 分辨率 / 帧率 / 时间基 / 音频参数），用于兼容性检查、进度估算与转码对齐
            List<JoinSpec> specs = new List<JoinSpec>();
            foreach (string c in clips)
            {
                JoinSpec sp = new JoinSpec();
                try { sp = Media.ProbeJoin(c); } catch { }
                specs.Add(sp);
            }

            double totalDur = 0;
            bool allAudio = true;
            foreach (JoinSpec sp in specs)
            {
                totalDur += sp.Duration;
                if (!sp.HasAudio) allAudio = false;
            }
            if (!allAudio && !encode)
                AppendLog("[注意] 有片段没有音频流，拼接结果可能也是无声的；若片段本身都应有声，请先核实片段文件。");
            else if (!allAudio && encode)
                AppendLog("[提示] 有片段没有音频流，本次按「仅画面」拼接（无声音）。");

            // 直接拼接前先核对片段参数；不一致会导致加速 / 花屏 / 音画不同步
            JoinSpec target = null;
            if (!encode)
            {
                List<string> diffs = CheckJoinCompat(specs);
                if (diffs.Count > 0)
                {
                    StringBuilder msg = new StringBuilder();
                    msg.AppendLine("检测到片段参数不一致，直接拼接会出现「后半段加速、花屏或音画不同步」等问题：");
                    msg.AppendLine();
                    for (int i = 0; i < specs.Count && i < clips.Count; i++)
                        msg.AppendLine("片段" + (i + 1) + "：" + Path.GetFileName(specs[i].File) + Environment.NewLine
                            + "          " + specs[i].Desc());
                    msg.AppendLine();
                    foreach (string d in diffs) msg.AppendLine("· " + d);
                    msg.AppendLine();
                    JoinSpec best = LongestSpec(specs);
                    if (best.HasVideo && best.W > 0 && best.H > 0)
                        msg.AppendLine("是否自动改用「统一转码拼接」？（所有片段按最长的片段对齐到 " + best.W + "×" + best.H
                            + "，宽高比不同的片段按比例缩放补黑边；转码较慢。选「否」取消本次拼接）");
                    else
                        msg.AppendLine("是否自动改用「统一转码拼接」？（转码较慢。选「否」取消本次拼接）");
                    if (MessageBox.Show(this, msg.ToString(), "片段参数不一致", MessageBoxButtons.YesNo, MessageBoxIcon.Warning) != DialogResult.Yes)
                        return;
                    encode = true;
                    target = best;
                    AppendLog("[提示] 片段参数不一致，已自动改用「统一转码拼接」。差异：");
                    foreach (string d in diffs) AppendLog("    · " + d);
                }
            }

            string args = BuildJoinArgs(clips, encode, fullOut, allAudio, specs, target);

            StringBuilder intro = new StringBuilder();
            intro.Append("—— 拼接 " + clips.Count + " 个片段（" + (encode ? "统一转码" : "直接复制") + "）：");
            for (int i = 0; i < clips.Count; i++) intro.Append((i > 0 ? " + " : "") + Path.GetFileName(clips[i]));
            AppendLog(intro.ToString());
            foreach (string line in BuildJoinHints) AppendLog(line);
            BuildJoinHints.Clear();

            Job job = new Job();
            job.Kind = 3;
            job.Output = fullOut;
            job.VideoDuration = totalDur;

            StartFfmpegJob(args, job, new Action<JobResult>(OnJoinDone), clipProgress, "拼接中…");
        }

        private List<string> BuildJoinHints = new List<string>();

        // 找出时长最长且含视频的片段（统一转码的对齐目标）
        private static JoinSpec LongestSpec(List<JoinSpec> specs)
        {
            JoinSpec best = null;
            foreach (JoinSpec s in specs)
            {
                if (!s.HasVideo) continue;
                if (best == null || s.Duration > best.Duration) best = s;
            }
            if (best == null && specs.Count > 0) best = specs[0];
            return best;
        }

        // 直接拼接兼容性检查：返回差异列表（空 = 可以直接拼）
        private List<string> CheckJoinCompat(List<JoinSpec> specs)
        {
            List<string> diffs = new List<string>();
            JoinSpec v0 = null;
            int vi = -1;
            for (int i = 0; i < specs.Count; i++)
            {
                if (specs[i].HasVideo)
                {
                    if (v0 == null) { v0 = specs[i]; vi = i; }
                }
                else diffs.Add("片段" + (i + 1) + " 没有视频流");
            }
            if (v0 == null) { diffs.Clear(); diffs.Add("没有片段包含视频流"); return diffs; }

            for (int i = 0; i < specs.Count; i++)
            {
                JoinSpec s = specs[i];
                if (!s.HasVideo || i == vi) continue;
                int n = i + 1;
                if (s.VCodec != v0.VCodec) diffs.Add("片段" + n + " 视频编码是 " + s.VCodec + "，片段" + (vi + 1) + " 是 " + v0.VCodec);
                if (s.W != v0.W || s.H != v0.H) diffs.Add("片段" + n + " 分辨率是 " + s.W + "×" + s.H + "，片段" + (vi + 1) + " 是 " + v0.W + "×" + v0.H);
                if (s.TbNum != v0.TbNum || s.TbDen != v0.TbDen) diffs.Add("片段" + n + " 时间基是 " + s.TbNum + "/" + s.TbDen + "，片段" + (vi + 1) + " 是 " + v0.TbNum + "/" + v0.TbDen);
                if (s.Fps > 0 && v0.Fps > 0 && Math.Abs(s.Fps - v0.Fps) / Math.Max(s.Fps, v0.Fps) > 0.01)
                    diffs.Add("片段" + n + " 帧率约 " + Math.Round(s.Fps, 2) + " fps，片段" + (vi + 1) + " 约 " + Math.Round(v0.Fps, 2) + " fps");
            }

            // 音频一致性（和第一个有音频的片段比）
            JoinSpec a0 = null;
            int ai = -1;
            for (int i = 0; i < specs.Count; i++)
            {
                if (!specs[i].HasAudio) continue;
                a0 = specs[i]; ai = i; break;
            }
            if (a0 != null)
            {
                for (int i = 0; i < specs.Count; i++)
                {
                    JoinSpec s = specs[i];
                    int n = i + 1;
                    if (!s.HasAudio) { diffs.Add("片段" + n + " 没有音频流，其它片段有"); continue; }
                    if (i == ai) continue;
                    if (s.ACodec != a0.ACodec) diffs.Add("片段" + n + " 音频编码是 " + s.ACodec + "，片段" + (ai + 1) + " 是 " + a0.ACodec);
                    if (s.ASampleRate > 0 && a0.ASampleRate > 0 && s.ASampleRate != a0.ASampleRate)
                        diffs.Add("片段" + n + " 音频采样率是 " + (int)s.ASampleRate + "Hz，片段" + (ai + 1) + " 是 " + (int)a0.ASampleRate + "Hz");
                    if (s.AChannels > 0 && a0.AChannels > 0 && s.AChannels != a0.AChannels)
                        diffs.Add("片段" + n + " 是 " + s.AChannels + " 声道，片段" + (ai + 1) + " 是 " + a0.AChannels + " 声道");
                }
            }
            return diffs;
        }

        private string BuildJoinArgs(List<string> clips, bool encode, string fullOut, bool allAudio,
            List<JoinSpec> specs, JoinSpec target)
        {
            bool mkv = U.Ext(fullOut) == "mkv";
            StringBuilder sb = new StringBuilder();
            sb.Append("-hide_banner -nostats -y ");

            if (encode)
            {
                foreach (string c in clips) sb.Append("-i " + U.Q(c) + " ");

                // 对齐目标：弹窗回退时已指定；手动选转码时按最长的片段
                if (target == null) target = LongestSpec(specs);
                if (target == null) target = new JoinSpec();

                // x264 yuv420p 要求偶数宽高
                int w = target.W > 0 ? target.W - target.W % 2 : 0;
                int h = target.H > 0 ? target.H - target.H % 2 : 0;
                string fpsTxt = target.Fps > 0 && target.FpsTxt.Length > 0 ? target.FpsTxt : "";
                double sr = target.ASampleRate > 0 ? target.ASampleRate : 44100;
                string layout = target.AChannels == 1 ? "mono" : (target.AChannels == 6 ? "5.1" : "stereo");

                bool ratioUp = false;   // 宽高比与目标不同（提示会补黑边）
                int n = clips.Count;
                StringBuilder fc = new StringBuilder();
                for (int i = 0; i < n; i++)
                {
                    JoinSpec s = i < specs.Count ? specs[i] : null;
                    if (w > 0 && h > 0)
                    {
                        if (s != null && s.HasVideo && s.W > 0 && s.H > 0) ratioUp |=
                            Math.Abs((double)s.W / s.H - (double)target.W / target.H) / ((double)target.W / target.H) > 0.01;
                        fc.Append("[" + i + ":v]scale=" + w + ":" + h + ":force_original_aspect_ratio=decrease");
                        fc.Append(",pad=" + w + ":" + h + ":(ow-iw)/2:(oh-ih)/2:black,setsar=1");
                        if (fpsTxt.Length > 0) fc.Append(",fps=" + fpsTxt);
                        fc.Append(",format=yuv420p[v" + i + "];");
                    }
                    else
                        fc.Append("[" + i + ":v]setsar=1[v" + i + "];");
                    if (allAudio) fc.Append("[" + i + ":a]aresample=" + (int)sr + ",aformat=sample_fmts=fltp:channel_layouts=" + layout + "[a" + i + "];");
                }
                // concat 的输入直接串联各链路输出，顺序为：每个片段依次「视频、音频」
                for (int i = 0; i < n; i++)
                {
                    fc.Append("[v" + i + "]");
                    if (allAudio) fc.Append("[a" + i + "]");
                }
                fc.Append("concat=n=" + n + ":v=1:a=" + (allAudio ? "1" : "0"));
                fc.Append("[vv]" + (allAudio ? "[aa]" : ""));
                sb.Append("-filter_complex " + U.Q(fc.ToString()) + " ");
                sb.Append("-map \"[vv]\" ");
                if (allAudio) sb.Append("-map \"[aa]\" ");
                sb.Append("-c:v libx264 -preset veryfast -crf 20 -pix_fmt yuv420p ");
                if (allAudio) sb.Append("-c:a aac -b:a 192k ");
                if (!mkv) sb.Append("-movflags +faststart ");
                sb.Append("-max_muxing_queue_size 4096 ");

                if (w > 0 && h > 0)
                    BuildJoinHints.Add("统一转码：所有片段按最长的片段「" + Path.GetFileName(target.File) + "」的 "
                        + w + "×" + h + "对齐后拼接" + (ratioUp ? "（宽高比不同的片段按比例缩放并补黑边，不拉伸变形）" : "") + "。");
            }
            else
            {
                // concat demuxer：写临时清单文件
                string dir = Path.GetDirectoryName(fullOut);
                if (string.IsNullOrEmpty(dir)) dir = U.ExeDir();
                if (joinListFile.Length > 0) { try { File.Delete(joinListFile); } catch { } }
                joinListFile = Path.Combine(dir, "_拼接清单_" + DateTime.Now.ToString("yyyyMMddHHmmss") + ".txt");

                StringBuilder lst = new StringBuilder();
                foreach (string c in clips)
                {
                    string p = c.Replace("\\", "/").Replace("'", "'\\''");
                    lst.Append("file '" + p + "'").AppendLine();
                }
                File.WriteAllText(joinListFile, lst.ToString(), new UTF8Encoding(false));

                sb.Append("-f concat -safe 0 -i " + U.Q(joinListFile) + " ");
                sb.Append("-c copy -avoid_negative_ts make_zero ");
                if (!mkv) sb.Append("-movflags +faststart ");
                sb.Append("-max_muxing_queue_size 4096 ");
            }

            sb.Append("-progress pipe:1 ");
            sb.Append("-loglevel info ");
            sb.Append(U.Q(fullOut));
            return sb.ToString();
        }

        private void OnJoinDone(JobResult r)
        {
            if (joinListFile.Length > 0)
            {
                try { File.Delete(joinListFile); } catch { }
                joinListFile = "";
            }
            if (r.Ok)
            {
                lblClipStatus.Text = "拼接完成 ✓";
                AppendLog("完成：输出 " + U.FmtSize(r.Size) + "，时长 " + U.FmtTime(r.Duration));
                if (currentJob != null) AppendLog("文件已保存：" + currentJob.Output);
            }
            else if (r.Stopped)
            {
                lblClipStatus.Text = "已停止";
            }
            else
            {
                lblClipStatus.Text = "拼接失败";
                AppendLog("[失败] " + r.Message);
                string hint = HintForFailure(r.Details);
                if (hint.Length > 0) AppendLog("[建议] " + hint);
                if (!r.Stopped) AppendLog("[建议] 各片段编码 / 分辨率不一致时，「直接拼接」会失败，请换「统一转码拼接」再试。");
            }
        }

        private void OnSaveOutAs(object sender, EventArgs e)
        {
            Button b = (Button)sender;
            TextBox t = b.Tag as TextBox;
            if (t == null) return;
            SaveFileDialog d = new SaveFileDialog();
            d.Title = "指定输出文件";
            d.Filter = "所有文件|*.*";
            string cur = t.Text.Trim();
            if (cur.Length > 0)
            {
                d.FileName = Path.GetFileName(cur);
                try { string dir = Path.GetDirectoryName(cur); if (dir != null && dir.Length > 0) d.InitialDirectory = dir; }
                catch { }
            }
            if (d.ShowDialog(this) == DialogResult.OK) t.Text = d.FileName;
        }

        private void OnExSrcChanged(object sender, EventArgs e)
        {
            SuggestExOut();
            ProbeInfoLabel(txtExSrc.Text.Trim(), lblExInfo);
        }

        private void OnPicSrcChanged(object sender, EventArgs e)
        {
            SuggestPicOut();
            ProbeInfoLabel(txtPicSrc.Text.Trim(), lblPicInfo);

            // 换视频：作废旧取帧任务并清空预览
            picToken++;
            picFrameToken++;
            pendingPicFrame = -1;
            if (picFrameTimer != null) picFrameTimer.Stop();
            ClearPicTempDir();
            ClearPicVisuals();
            picSrcDur = 0;
            if (lblPicPos != null) lblPicPos.Text = "";
            if (lblPicSummary != null) lblPicSummary.Text = "";

            string src = txtPicSrc.Text.Trim();
            if (src.Length == 0 || !File.Exists(src) || !Ffmpeg.ProbeReady)
            {
                if (lblPicSummary != null) lblPicSummary.Text = "选择视频后，这里会显示输出尺寸和已启用的调整项。\n（预览为近似效果，实际以输出文件为准）";
                return;
            }

            try { picSrcDur = Media.Probe(src, true).Duration; }
            catch { picSrcDur = 0; }

            if (trkPicPos != null && picSrcDur > 0)
            {
                int max = (int)Math.Round(picSrcDur * 10.0);
                if (max < 1) max = 1;
                trkPicPos.Minimum = 0;
                trkPicPos.Maximum = max;
                trkPicPos.Value = 0;
                SetPicPosLabel(0);
                GrabPicFrame(0);
            }
            else if (lblPicPos != null)
            {
                lblPicPos.Text = "读不出视频时长，仍可直接开始处理";
            }
        }

        // ================ 画面调整：实时预览 / 处理执行 ================

        // 可选的目标分辨率（与下拉框对应）
        private static readonly int[][] PicSizes = new int[][]
        {
            new int[] { 1920, 1080 },
            new int[] { 1280, 720 },
            new int[] { 854, 480 },
            new int[] { 640, 360 }
        };

        // 旋转角度（与下拉框对应）
        private static readonly int[] PicRotateDeg = new int[] { 90, 180, 270 };

        private static int PicCropVal(string s)
        {
            int v;
            if (!int.TryParse((s == null ? "" : s).Trim(), out v) || v < 0) return 0;
            return v;
        }

        private static string FmtAdj(int v)
        {
            if (v == 0) return "0";
            string s = (Math.Abs(v) / 100.0).ToString("0.0#", System.Globalization.CultureInfo.InvariantCulture);
            return (v > 0 ? "+" : "-") + s;
        }

        // 清空画面预览（控件还在，等新视频）
        private void ClearPicVisuals()
        {
            if (picOrig != null)
            {
                Image old = picOrig.Image;
                picOrig.Image = null;
                if (old != null && !ReferenceEquals(old, picFrame)) old.Dispose();
                picOrig.Invalidate();
            }
            if (picAdj != null)
            {
                Image old = picAdj.Image;
                picAdj.Image = null;
                if (old != null) old.Dispose();
            }
            if (picFrame != null) { picFrame.Dispose(); picFrame = null; }
            if (hintPicOrig != null)
            {
                hintPicOrig.Visible = true;
                hintPicOrig.Text = "选择视频后自动抓取画面";
            }
            if (hintPicAdj != null)
            {
                hintPicAdj.Visible = true;
                hintPicAdj.Text = "调整后画面（实时）";
            }
        }

        // 删除预览帧临时目录
        private void ClearPicTempDir()
        {
            try { if (picTempDir.Length > 0 && Directory.Exists(picTempDir)) Directory.Delete(picTempDir, true); }
            catch { }
            picTempDir = "";
        }

        private void SetPicPosLabel(double t)
        {
            if (lblPicPos == null) return;
            if (picSrcDur <= 0) { lblPicPos.Text = ""; return; }
            lblPicPos.Text = "取样位置 " + U.FmtTimeP(t) + " / 总 " + U.FmtTime(picSrcDur) + "（拖动滑块换画面）";
        }

        // 取样位置滑块变化：去抖后重新抓帧
        private void OnPicPosScroll(object sender, EventArgs e)
        {
            if (trkPicPos == null || picSrcDur <= 0) return;
            double t = trkPicPos.Value / 10.0;
            SetPicPosLabel(t);
            pendingPicFrame = t;
            picFrameTimer.Stop();
            picFrameTimer.Start();
        }

        private void OnPicFrameTick(object sender, EventArgs e)
        {
            picFrameTimer.Stop();
            if (pendingPicFrame >= 0)
            {
                double t = pendingPicFrame;
                pendingPicFrame = -1;
                GrabPicFrame(t);
            }
        }

        private void OnPicRegrab(object sender, EventArgs e)
        {
            if (trkPicPos == null || picSrcDur <= 0) return;
            double t = trkPicPos.Value / 10.0;
            SetPicPosLabel(t);
            GrabPicFrame(t);
        }

        // 后台抓一帧原始画面（不套任何调整）
        private void GrabPicFrame(double t)
        {
            string src = txtPicSrc.Text.Trim();
            if (src.Length == 0 || !File.Exists(src) || !Ffmpeg.Ready || picSrcDur <= 0) return;
            if (t < 0) t = 0;
            if (t > picSrcDur - 0.1) t = Math.Max(0, picSrcDur - 0.1);

            if (picTempDir.Length == 0)
            {
                picTempDir = Path.Combine(Path.GetTempPath(), "AVMergePic_" + Guid.NewGuid().ToString("N").Substring(0, 8));
                try { Directory.CreateDirectory(picTempDir); }
                catch { picTempDir = ""; return; }
            }

            string outFile = Path.Combine(picTempDir, "frame.jpg");
            picFrameToken++;
            int token = picFrameToken;

            string ts = t.ToString("0.###", System.Globalization.CultureInfo.InvariantCulture);
            string args = "-hide_banner -v error -y -ss " + ts + " -i " + U.Q(src) +
                " -frames:v 1 -q:v 3 -f image2 " + U.Q(outFile);

            ThreadPool.QueueUserWorkItem(new WaitCallback(delegate(object state)
            {
                RunFfmpegQuiet(args, 30000);

                Bitmap bmp = null;
                if (token == picFrameToken)
                {
                    try
                    {
                        if (File.Exists(outFile) && new FileInfo(outFile).Length > 0)
                        {
                            using (Image img = Image.FromFile(outFile)) bmp = new Bitmap(img);
                        }
                    }
                    catch { }
                }

                try
                {
                    this.BeginInvoke(new MethodInvoker(delegate()
                    {
                        if (token != picFrameToken || picOrig == null)
                        {
                            if (bmp != null) bmp.Dispose();
                            return;
                        }
                        ShowPicFrame(bmp);
                    }));
                }
                catch { if (bmp != null) bmp.Dispose(); }
            }));
        }

        private void ShowPicFrame(Bitmap bmp)
        {
            Image old = picOrig.Image;
            if (picFrame != null) picFrame.Dispose();
            picFrame = bmp;
            picOrig.Image = bmp;
            if (old != null && !ReferenceEquals(old, bmp) && !ReferenceEquals(old, picFrame)) old.Dispose();
            hintPicOrig.Visible = bmp == null;

            if (bmp != null)
            {
                picOrig.Invalidate();       // 重画裁剪标记
                RenderPicAdj();
                UpdatePicSummary();
            }
            else
            {
                hintPicOrig.Text = "读不到该位置画面（可能是音频文件）";
            }
        }

        // 裁剪标记：在原图上用红色虚线标出裁剪保留区
        private void OnPicCropPaint(object sender, PaintEventArgs e)
        {
            if (picFrame == null || picOrig == null) return;
            int l = PicCropVal(txtCropLeft.Text), r = PicCropVal(txtCropRight.Text);
            int t = PicCropVal(txtCropTop.Text), b = PicCropVal(txtCropBottom.Text);
            if (l + r + t + b == 0) return;

            int iw = picFrame.Width, ih = picFrame.Height;
            if (l + r >= iw || t + b >= ih || iw <= 0 || ih <= 0) return;

            int cw = picOrig.ClientSize.Width, ch = picOrig.ClientSize.Height;
            double scale = Math.Min(cw / (double)iw, ch / (double)ih);
            if (scale <= 0) return;
            double dw = iw * scale, dh = ih * scale;
            double ox = (cw - dw) / 2.0, oy = (ch - dh) / 2.0;

            RectangleF rect = new RectangleF(
                (float)(ox + l * scale), (float)(oy + t * scale),
                (float)Math.Max(2.0, (iw - l - r) * scale) - 1, (float)Math.Max(2.0, (ih - t - b) * scale) - 1);

            using (Pen p = new Pen(Color.FromArgb(230, 235, 60, 70), 1.5f))
            {
                p.DashStyle = DashStyle.Dash;
                e.Graphics.DrawRectangle(p, rect.X, rect.Y, rect.Width, rect.Height);
            }
        }

        // 右侧「调整后」预览：裁剪 → 旋转 / 翻转 → 缩放 → 调色（GDI+ 实时复刻 ffmpeg 滤镜链）
        private void RenderPicAdj()
        {
            try
            {
                if (picFrame == null)
                {
                    Image old = picAdj.Image;
                    picAdj.Image = null;
                    if (old != null) old.Dispose();
                    hintPicAdj.Visible = true;
                    return;
                }

                Bitmap outBmp = PicTransform(picFrame);
                Image old2 = picAdj.Image;
                picAdj.Image = outBmp;
                if (old2 != null && !ReferenceEquals(old2, outBmp) && !ReferenceEquals(old2, picFrame)) old2.Dispose();
                hintPicAdj.Visible = false;
            }
            catch (Exception ex)
            {
                U.CrashLog(ex);
            }
        }

        // 依当前界面参数对一帧画面做完整调整（预览 / 摘要共用同一套取值）
        private Bitmap PicTransform(Bitmap src)
        {
            int l = PicCropVal(txtCropLeft.Text), r = PicCropVal(txtCropRight.Text);
            int t = PicCropVal(txtCropTop.Text), b = PicCropVal(txtCropBottom.Text);

            Bitmap cur = src;
            Bitmap created = null;

            // 1) 裁剪
            int iw = src.Width, ih = src.Height;
            if (l + r >= iw) r = Math.Max(0, iw - l - 2);
            if (t + b >= ih) b = Math.Max(0, ih - t - 2);
            if (l > 0 || r > 0 || t > 0 || b > 0)
            {
                int cw = iw - l - r, ch = ih - t - b;
                if (cw > 0 && ch > 0)
                {
                    created = new Bitmap(cw, ch);
                    using (Graphics g = Graphics.FromImage(created))
                        g.DrawImage(src, new Rectangle(0, 0, cw, ch), l, t, cw, ch, GraphicsUnit.Pixel);
                    cur = created;
                    iw = cw; ih = ch;
                }
            }

            // 2) 旋转 / 镜像
            bool hf = chkPicHFlip.Checked, vf = chkPicVFlip.Checked;
            int rot = (chkPicRotate.Checked && cmbPicRotate.SelectedIndex >= 0)
                ? PicRotateDeg[Math.Min(cmbPicRotate.SelectedIndex, PicRotateDeg.Length - 1)] : 0;
            if (rot > 0 || hf || vf)
            {
                Bitmap rb = new Bitmap(iw, ih);
                using (Graphics g = Graphics.FromImage(rb)) g.DrawImage(cur, 0, 0, iw, ih);
                if (rot == 90) rb.RotateFlip(RotateFlipType.Rotate90FlipNone);
                else if (rot == 180) rb.RotateFlip(RotateFlipType.Rotate180FlipNone);
                else if (rot == 270) rb.RotateFlip(RotateFlipType.Rotate270FlipNone);
                if (hf) rb.RotateFlip(RotateFlipType.RotateNoneFlipX);
                if (vf) rb.RotateFlip(RotateFlipType.RotateNoneFlipY);
                if (created != null) created.Dispose();
                created = rb;
                cur = rb;
                iw = rb.Width; ih = rb.Height;
            }

            // 3) 缩放（保持宽高比 + 黑边补齐，与视频统一转码的做法一致）
            Bitmap fin = cur;
            Bitmap scaled = null;
            if (chkPicScale.Checked && cmbPicSize.SelectedIndex >= 0)
            {
                int[] tgt = PicSizes[Math.Min(cmbPicSize.SelectedIndex, PicSizes.Length - 1)];
                int tw = tgt[0] - tgt[0] % 2, th = tgt[1] - tgt[1] % 2;
                scaled = new Bitmap(tw, th);
                using (Graphics g = Graphics.FromImage(scaled))
                {
                    g.Clear(Color.Black);
                    g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
                    double s = Math.Min(tw / (double)cur.Width, th / (double)cur.Height);
                    int dw = Math.Max(1, (int)Math.Round(cur.Width * s));
                    int dh = Math.Max(1, (int)Math.Round(cur.Height * s));
                    g.DrawImage(cur, (tw - dw) / 2, (th - dh) / 2, dw, dh);
                }
                if (created != null) created.Dispose();
                created = scaled;
                fin = scaled;
            }

            // 4) 调色（亮度 / 对比度 / 饱和度）
            double bright = trkPicBright.Value / 100.0;
            double c = 1.0 + trkPicContrast.Value / 100.0;
            double sat = 1.0 + trkPicSat.Value / 100.0;
            bool needEq = Math.Abs(bright) > 0.0001 ||
                          Math.Abs(trkPicContrast.Value) > 0 || Math.Abs(trkPicSat.Value) > 0;
            if (needEq)
            {
                Bitmap eq = ApplyEq(fin, bright, c, sat);
                if (created != null) created.Dispose();
                fin = eq;
            }
            return fin;
        }

        // ColorMatrix 近似 ffmpeg eq：输出 = 对比度 ×（饱和度(像素) − 0.5）+ 0.5 + 亮度
        private static Bitmap ApplyEq(Bitmap src, double bright, double contrast, double saturation)
        {
            Bitmap dst = new Bitmap(src.Width, src.Height);
            float c = (float)contrast;
            float off = (float)(bright + 0.5 - 0.5 * c) * 255f;
            float sr = 0.3086f, sg = 0.6094f, sb = 0.0820f;
            float s = (float)saturation;

            System.Drawing.Imaging.ColorMatrix m = new System.Drawing.Imaging.ColorMatrix();
            m.Matrix00 = c * ((1 - s) * sr + s);
            m.Matrix01 = c * (1 - s) * sr;
            m.Matrix02 = c * (1 - s) * sr;
            m.Matrix10 = c * (1 - s) * sg;
            m.Matrix11 = c * ((1 - s) * sg + s);
            m.Matrix12 = c * (1 - s) * sg;
            m.Matrix20 = c * (1 - s) * sb;
            m.Matrix21 = c * (1 - s) * sb;
            m.Matrix22 = c * ((1 - s) * sb + s);
            m.Matrix04 = off;
            m.Matrix14 = off;
            m.Matrix24 = off;

            using (Graphics g = Graphics.FromImage(dst))
            using (System.Drawing.Imaging.ImageAttributes ia = new System.Drawing.Imaging.ImageAttributes())
            {
                ia.SetColorMatrix(m);
                ia.SetWrapMode(System.Drawing.Drawing2D.WrapMode.TileFlipXY);
                g.DrawImage(src, new Rectangle(0, 0, src.Width, src.Height),
                    0, 0, src.Width, src.Height, GraphicsUnit.Pixel, ia);
            }
            return dst;
        }

        // 输出尺寸 / 已启用调整项摘要
        private void UpdatePicSummary()
        {
            if (lblPicSummary == null) return;
            if (picFrame == null) { lblPicSummary.Text = ""; return; }

            int l = PicCropVal(txtCropLeft.Text), r = PicCropVal(txtCropRight.Text);
            int t = PicCropVal(txtCropTop.Text), b = PicCropVal(txtCropBottom.Text);
            int iw = picFrame.Width, ih = picFrame.Height;
            if (l + r >= iw) r = Math.Max(0, iw - l - 2);
            if (t + b >= ih) b = Math.Max(0, ih - t - 2);
            int cw = iw - l - r, ch = ih - t - b;

            int rot = (chkPicRotate.Checked && cmbPicRotate.SelectedIndex >= 0)
                ? PicRotateDeg[Math.Min(cmbPicRotate.SelectedIndex, PicRotateDeg.Length - 1)] : 0;
            if (rot == 90 || rot == 270) { int sw = cw; cw = ch; ch = sw; }

            int ow = cw, oh = ch;
            if (chkPicScale.Checked && cmbPicSize.SelectedIndex >= 0)
            {
                int[] tgt = PicSizes[Math.Min(cmbPicSize.SelectedIndex, PicSizes.Length - 1)];
                ow = tgt[0]; oh = tgt[1];
            }

            List<string> eff = new List<string>();
            if (l + r + t + b > 0) eff.Add("裁剪（上" + t + " 下" + b + " 左" + l + " 右" + r + "）");
            if (rot > 0) eff.Add("旋转 " + rot + "°");
            if (chkPicHFlip.Checked) eff.Add("水平镜像");
            if (chkPicVFlip.Checked) eff.Add("垂直翻转");
            if (chkPicScale.Checked && cmbPicSize.SelectedIndex >= 0) eff.Add("缩放到 " + ow + "×" + oh);
            if (trkPicBright.Value != 0) eff.Add("亮度 " + FmtAdj(trkPicBright.Value));
            if (trkPicContrast.Value != 0) eff.Add("对比度 " + FmtAdj(trkPicContrast.Value));
            if (trkPicSat.Value != 0) eff.Add("饱和度 " + FmtAdj(trkPicSat.Value));

            StringBuilder sb = new StringBuilder();
            sb.AppendLine("源画面 " + iw + "×" + ih + "（取样点原始分辨率）");
            sb.AppendLine("输出尺寸 " + ow + "×" + oh);
            sb.AppendLine(eff.Count == 0 ? "未启用任何调整，输出与源相同" : "已启用：" + string.Join("、", eff.ToArray()));
            sb.AppendLine("（预览为近似效果，实际以输出文件为准）");
            lblPicSummary.Text = sb.ToString();
        }

        // 所有调整参数变化 → 实时重画预览
        private void OnPicAdjChanged(object sender, EventArgs e)
        {
            if (sender == cmbPicRotate && chkPicRotate != null && !chkPicRotate.Checked)
                chkPicRotate.Checked = true;    // 选了角度自动勾上「旋转」

            if (lblPicBrightVal != null) lblPicBrightVal.Text = FmtAdj(trkPicBright.Value);
            if (lblPicContrastVal != null) lblPicContrastVal.Text = FmtAdj(trkPicContrast.Value);
            if (lblPicSatVal != null) lblPicSatVal.Text = FmtAdj(trkPicSat.Value);
            if (picFrame != null)
            {
                picOrig.Invalidate();
                RenderPicAdj();
                UpdatePicSummary();
            }
        }

        // ---------------- 画面调整：开始处理 ----------------

        private void OnPicStart(object sender, EventArgs e)
        {
            if (batchRunning)
            {
                MessageBox.Show(this, "正在批量合并，请等它结束后再处理。", "提示", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            if (running)
            {
                MessageBox.Show(this, "上一个任务还在进行，请等它结束或点停止。", "提示", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            if (!Ffmpeg.Ready)
            {
                MessageBox.Show(this, "还没有可用的 ffmpeg。请切到合并模式点「指定 ffmpeg」。", "缺少 ffmpeg", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                btnFindFfmpeg.Visible = true;
                return;
            }

            string src = txtPicSrc.Text.Trim();
            if (src.Length == 0 || !File.Exists(src))
            {
                MessageBox.Show(this, "请先选择存在的视频文件。", "提示", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }

            // 源分辨率（裁剪合法性判断用）
            int sw = 0, sh = 0;
            if (picFrame != null) { sw = picFrame.Width; sh = picFrame.Height; }
            else if (Ffmpeg.ProbeReady)
            {
                try { MediaInfo m = Media.Probe(src, true); sw = m.Width; sh = m.Height; }
                catch { }
            }

            int cl = PicCropVal(txtCropLeft.Text), cr = PicCropVal(txtCropRight.Text);
            int ct = PicCropVal(txtCropTop.Text), cb = PicCropVal(txtCropBottom.Text);
            if (sw > 0 && (cl + cr >= sw || ct + cb >= sh))
            {
                MessageBox.Show(this,
                    "裁剪量太大：裁完必须至少保留 2 像素画面（当前源画面 " + sw + "×" + sh + "）。",
                    "提示", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }

            if (txtPicOut.Text.Trim().Length == 0) SuggestPicOut();
            string outRaw = txtPicOut.Text.Trim();
            if (outRaw.Length == 0)
            {
                MessageBox.Show(this, "请指定输出文件。", "提示", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }

            string ext = cmbPicFormat.SelectedIndex == 1 ? "mkv" : "mp4";
            string fullOut = Path.GetFullPath(outRaw);
            string outDir = Path.GetDirectoryName(fullOut);
            if (outDir == null || !Directory.Exists(outDir))
            {
                MessageBox.Show(this, "输出文件夹不存在：" + outDir, "提示", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }
            if (string.Equals(fullOut, Path.GetFullPath(src), StringComparison.OrdinalIgnoreCase))
            {
                MessageBox.Show(this, "输出文件不能和源文件是同一个，否则会覆盖原始文件。请换个输出文件名。", "提示", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }
            if (U.Ext(fullOut) != ext)
            {
                fullOut = Path.ChangeExtension(fullOut, "." + ext);
                AppendLog("[提示] 输出扩展名已按所选格式改为 ." + ext + "，保存为 " + Path.GetFileName(fullOut));
            }

            // ---- 滤镜链：crop → 旋转 → 镜像 → scale + pad → eq ----
            List<string> vf = new List<string>();
            if (cl + cr > 0 || ct + cb > 0)
                vf.Add("crop=w=iw-" + (cl + cr) + ":h=ih-" + (ct + cb) + ":x=" + cl + ":y=" + ct);

            int rot = (chkPicRotate.Checked && cmbPicRotate.SelectedIndex >= 0)
                ? PicRotateDeg[Math.Min(cmbPicRotate.SelectedIndex, PicRotateDeg.Length - 1)] : 0;
            if (rot == 90) vf.Add("transpose=1");
            else if (rot == 180) { vf.Add("hflip"); vf.Add("vflip"); }
            else if (rot == 270) vf.Add("transpose=2");
            if (chkPicHFlip.Checked) vf.Add("hflip");
            if (chkPicVFlip.Checked) vf.Add("vflip");

            bool scaled = chkPicScale.Checked && cmbPicSize.SelectedIndex >= 0;
            int tw = 0, th = 0;
            if (scaled)
            {
                int[] tgt = PicSizes[Math.Min(cmbPicSize.SelectedIndex, PicSizes.Length - 1)];
                tw = tgt[0] - tgt[0] % 2; th = tgt[1] - tgt[1] % 2;
                vf.Add("scale=" + tw + ":" + th + ":force_original_aspect_ratio=decrease");
                vf.Add("pad=" + tw + ":" + th + ":(ow-iw)/2:(oh-ih)/2:black");
                vf.Add("setsar=1");
            }
            else if (sw > 0)
            {
                // 没指定缩放但裁剪 / 旋转后像素不是偶数：补一刀裁到偶数，x264 才收
                int cw = sw - cl - cr, ch2 = sh - ct - cb;
                if (rot == 90 || rot == 270) { int x = cw; cw = ch2; ch2 = x; }
                if (cw % 2 != 0 || ch2 % 2 != 0)
                    vf.Add("crop=trunc(iw/2)*2:trunc(ih/2)*2");
            }

            double bright = trkPicBright.Value / 100.0;
            double contrast = 1.0 + trkPicContrast.Value / 100.0;
            double sat = 1.0 + trkPicSat.Value / 100.0;
            if (trkPicBright.Value != 0 || trkPicContrast.Value != 0 || trkPicSat.Value != 0)
            {
                System.Globalization.CultureInfo ci = System.Globalization.CultureInfo.InvariantCulture;
                vf.Add("eq=brightness=" + bright.ToString("0.###", ci)
                    + ":contrast=" + contrast.ToString("0.###", ci)
                    + ":saturation=" + sat.ToString("0.###", ci));
            }

            if (vf.Count == 0)
                AppendLog("[提示] 未选择任何调整，将原样重编码一遍（想改画面请先在上方勾选或拖滑杆）。");

            StringBuilder sb = new StringBuilder();
            sb.Append("-hide_banner -nostats -y ");
            sb.Append("-i " + U.Q(src) + " ");
            sb.Append("-map 0:v:0 -map 0:a:0? ");
            if (vf.Count > 0) sb.Append("-vf " + U.Q(string.Join(",", vf.ToArray())) + " ");
            sb.Append("-c:v libx264 -preset veryfast -crf 20 -pix_fmt yuv420p ");
            sb.Append("-c:a aac -b:a 192k ");
            if (ext == "mp4") sb.Append("-movflags +faststart ");
            sb.Append("-max_muxing_queue_size 4096 ");
            sb.Append("-progress pipe:1 ");
            sb.Append("-loglevel info ");
            sb.Append(U.Q(fullOut));

            double dur = picSrcDur;
            if (dur <= 0 && Ffmpeg.ProbeReady)
            {
                try { dur = Media.Probe(src, true).Duration; } catch { }
            }

            Job job = new Job();
            job.Kind = 4;
            job.Video = src;
            job.Output = fullOut;
            job.VideoDuration = dur;

            StringBuilder intro = new StringBuilder();
            intro.Append("—— 画面调整：");
            List<string> desc = new List<string>();
            if (cl + cr > 0 || ct + cb > 0) desc.Add("裁剪");
            if (rot > 0) desc.Add("旋转" + rot + "°");
            if (chkPicHFlip.Checked) desc.Add("水平镜像");
            if (chkPicVFlip.Checked) desc.Add("垂直翻转");
            if (scaled) desc.Add("缩放 " + tw + "×" + th);
            if (trkPicBright.Value != 0) desc.Add("亮度 " + FmtAdj(trkPicBright.Value));
            if (trkPicContrast.Value != 0) desc.Add("对比度 " + FmtAdj(trkPicContrast.Value));
            if (trkPicSat.Value != 0) desc.Add("饱和度 " + FmtAdj(trkPicSat.Value));
            intro.Append(desc.Count > 0 ? string.Join("，", desc.ToArray()) : "无调整（仅重编码）");
            AppendLog(intro.ToString());

            StartFfmpegJob(sb.ToString(), job, new Action<JobResult>(OnPicDone), picProgress, "画面调整中…");
        }

        private void OnPicDone(JobResult r)
        {
            if (r.Ok)
            {
                lblPicStatus.Text = "调整完成 ✓";
                AppendLog("完成：输出 " + U.FmtSize(r.Size) + "，时长 " + U.FmtTime(r.Duration));
                if (currentJob != null) AppendLog("文件已保存：" + currentJob.Output);
            }
            else if (r.Stopped)
            {
                lblPicStatus.Text = "已停止";
            }
            else
            {
                lblPicStatus.Text = "调整失败";
                AppendLog("[失败] " + r.Message);
                string hint = HintForFailure(r.Details);
                if (hint.Length > 0) AppendLog("[建议] " + hint);
            }
        }

        private void OnCvSrcChanged(object sender, EventArgs e)
        {
            SuggestCvOut();
            ProbeInfoLabel(txtCvSrc.Text.Trim(), lblCvInfo);
        }

        // ---------------- 格式转换 ----------------
        private static readonly int[][] CvDims = new int[][]
        {
            new int[] { 1920, 1080 }, new int[] { 1280, 720 }, new int[] { 854, 480 }, new int[] { 640, 360 }
        };

        private bool CvTargetIsGif { get { return cmbCvFormat != null && cmbCvFormat.SelectedIndex == CvExt.Length - 1; } }

        // 切换目标格式：GIF 没有声音、必须重编码，禁用相关选项；同时刷新自动命名
        private void OnCvFormatChanged(object sender, EventArgs e)
        {
            bool gif = CvTargetIsGif;
            if (cmbCvAudio != null) cmbCvAudio.Enabled = !gif;
            if (chkCvFast != null) chkCvFast.Enabled = !gif;
            if (gif && chkCvFast != null) chkCvFast.Checked = false;
            SuggestCvOut();
        }

        private void OnCvStart(object sender, EventArgs e)
        {
            if (batchRunning)
            {
                MessageBox.Show(this, "正在批量合并，请等它结束后再处理。", "提示", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            if (running)
            {
                MessageBox.Show(this, "上一个任务还在进行，请等它结束或点停止。", "提示", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            if (!Ffmpeg.Ready)
            {
                MessageBox.Show(this, "还没有可用的 ffmpeg。请切到合并模式点「指定 ffmpeg」。", "缺少 ffmpeg", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                btnFindFfmpeg.Visible = true;
                return;
            }

            string src = txtCvSrc.Text.Trim();
            if (src.Length == 0 || !File.Exists(src))
            {
                MessageBox.Show(this, "请先选择存在的源文件。", "提示", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }

            int fi = cmbCvFormat.SelectedIndex; if (fi < 0) fi = 0;
            if (fi >= CvExt.Length) fi = 0;
            string ext = CvExt[fi];
            bool gif = ext == "gif";
            bool audioTarget = (fi >= 5 && fi < CvExt.Length - 1);   // mp3 / m4a / wav / flac

            if (txtCvOut.Text.Trim().Length == 0) SuggestCvOut();
            string outRaw = txtCvOut.Text.Trim();
            if (outRaw.Length == 0)
            {
                MessageBox.Show(this, "请指定输出文件。", "提示", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }

            string fullOut = Path.GetFullPath(outRaw);
            string outDir = Path.GetDirectoryName(fullOut);
            if (outDir == null || !Directory.Exists(outDir))
            {
                MessageBox.Show(this, "输出文件夹不存在：" + outDir, "提示", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }
            if (string.Equals(fullOut, Path.GetFullPath(src), StringComparison.OrdinalIgnoreCase))
            {
                MessageBox.Show(this, "输出文件不能和源文件是同一个，否则会覆盖原始文件。请换个输出文件名。", "提示", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }
            if (U.Ext(fullOut) != ext)
            {
                fullOut = Path.ChangeExtension(fullOut, "." + ext);
                AppendLog("[提示] 输出扩展名已按所选格式改为 ." + ext + "，保存为 " + Path.GetFileName(fullOut));
            }

            // 探测源文件的视频流 / 音频流 / 时长
            MediaInfo mv = Media.Probe(src, true);
            MediaInfo ma = Media.Probe(src, false);
            bool srcHasVideo = mv.Codec.Length > 0;
            bool srcHasAudio = ma.Codec.Length > 0;
            double srcDur = mv.Duration > 0 ? mv.Duration : ma.Duration;

            // 源内容校验
            if (gif && !srcHasVideo)
            {
                MessageBox.Show(this, "源文件里没有视频画面，无法生成 GIF 动图。", "提示", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }
            if (audioTarget && !srcHasAudio)
            {
                MessageBox.Show(this, "源文件里没有音频轨道，无法转换成纯音频格式。", "提示", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }
            if (!gif && !audioTarget && !srcHasVideo)
            {
                MessageBox.Show(this, "源文件里没有视频画面，无法转换成视频格式。", "提示", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }

            int qi = cmbCvQuality.SelectedIndex; if (qi < 0) qi = 0;
            StringBuilder sb = new StringBuilder();
            sb.Append("-hide_banner -nostats -y ");
            sb.Append("-i " + U.Q(src) + " ");

            string modeDesc;
            bool fast = chkCvFast.Checked && !gif && !audioTarget;

            if (gif)
            {
                // ---- GIF：palettegen + paletteuse（一次性调色板，颜色过渡更自然）----
                int fps = qi == 0 ? 15 : qi == 1 ? 12 : 8;
                List<string> f = new List<string>();
                f.Add("fps=" + fps);
                if (cmbCvScale.SelectedIndex > 0)
                {
                    int[] tgt = CvDims[Math.Min(cmbCvScale.SelectedIndex - 1, CvDims.Length - 1)];
                    f.Add("scale=" + tgt[0] + ":" + tgt[1] + ":force_original_aspect_ratio=decrease:flags=lanczos");
                    modeDesc = "GIF " + fps + " fps · 缩放到 " + tgt[0] + "×" + tgt[1];
                }
                else if (mv.Width > 640)
                {
                    f.Add("scale=640:-1:flags=lanczos");
                    modeDesc = "GIF " + fps + " fps · 自动缩到 640 宽（源 " + mv.Width + "×" + mv.Height + "，可在「分辨率」里自选）";
                }
                else
                {
                    modeDesc = "GIF " + fps + " fps · 保持原尺寸";
                }
                f.Add("split[a][b];[a]palettegen[p];[b][p]paletteuse");
                sb.Append("-map 0:v:0 ");
                sb.Append("-vf " + U.Q(string.Join(",", f.ToArray())) + " ");
                sb.Append("-an ");
                AppendLog("—— 格式转换（GIF 动图，无声音）：" + Path.GetFileName(src) + " → " + Path.GetFileName(fullOut) + "（" + modeDesc + "）");
                AppendLog("[说明] GIF 是逐帧存储的动图格式，文件会比视频大很多，体积最小档（8 fps）更省空间。");
            }
            else if (!audioTarget)
            {
                // ---- 视频格式：MP4 / MKV / MOV / AVI / WEBM ----
                List<string> vf = new List<string>();
                bool scaled = cmbCvScale.SelectedIndex > 0;
                if (scaled && fast)
                {
                    AppendLog("[提示] 快速转换不重新编码，无法缩放画面，「分辨率」选项本次被忽略。");
                    scaled = false;
                }
                if (scaled)
                {
                    int[] tgt = CvDims[Math.Min(cmbCvScale.SelectedIndex - 1, CvDims.Length - 1)];
                    int tw = tgt[0] - tgt[0] % 2, th = tgt[1] - tgt[1] % 2;
                    vf.Add("scale=" + tw + ":" + th + ":force_original_aspect_ratio=decrease");
                    vf.Add("pad=" + tw + ":" + th + ":(ow-iw)/2:(oh-ih)/2:black");
                    vf.Add("setsar=1");
                }

                int ai = cmbCvAudio.SelectedIndex; if (ai < 0) ai = 0;
                string aKbps = ai == 1 ? "320" : ai == 2 ? "192" : "128";

                if (fast)
                {
                    sb.Append("-map 0:v:0 -map 0:a:0? ");
                    sb.Append("-c copy ");
                    if (ext == "mp4") sb.Append("-movflags +faststart ");
                    modeDesc = "快速转换（只换封装，不重编码）";
                }
                else
                {
                    if (vf.Count > 0) sb.Append("-vf " + U.Q(string.Join(",", vf.ToArray())) + " ");
                    sb.Append("-map 0:v:0 -map 0:a:0? ");
                    if (ext == "webm")
                    {
                        string crf = qi == 0 ? "31" : qi == 1 ? "35" : "40";
                        sb.Append("-c:v libvpx-vp9 -b:v 0 -crf " + crf + " ");
                        if (!srcHasAudio) sb.Append("-an ");
                        else if (ai > 0) sb.Append("-c:a libopus -b:a " + aKbps + "k ");
                        else if (ma.Codec == "opus" || ma.Codec == "vorbis") sb.Append("-c:a copy ");
                        else sb.Append("-c:a libopus -b:a 128k ");   // 其余编码 webm 收不了，转 opus
                        modeDesc = "重编码 VP9（CRF " + crf + "）+ Opus " + (ai > 0 ? aKbps + "k" : (srcHasAudio ? "128k" : "无"));
                    }
                    else
                    {
                        string crf = qi == 0 ? "18" : qi == 1 ? "23" : "28";
                        sb.Append("-c:v libx264 -preset veryfast -crf " + crf + " -pix_fmt yuv420p ");
                        if (!srcHasAudio) sb.Append("-an ");
                        else if (ai == 0) sb.Append("-c:a copy ");
                        else sb.Append("-c:a aac -b:a " + aKbps + "k ");
                        if (ext == "mp4") sb.Append("-movflags +faststart ");
                        modeDesc = "重编码 H.264（CRF " + crf + "）+ " + (ai > 0 ? "AAC " + aKbps + "k" : (srcHasAudio ? "音频原样" : "无音频"));
                    }
                }
                AppendLog("—— 格式转换：" + Path.GetFileName(src) + " → " + Path.GetFileName(fullOut) + "（" + modeDesc
                    + (scaled ? " · 缩放 " + CvDims[Math.Min(cmbCvScale.SelectedIndex - 1, CvDims.Length - 1)][0] + "×" + CvDims[Math.Min(cmbCvScale.SelectedIndex - 1, CvDims.Length - 1)][1] : "") + "）");
            }
            else
            {
                // ---- 纯音频：MP3 / M4A / WAV / FLAC ----
                sb.Append("-map 0:a:0 -vn ");
                string kbps = qi == 0 ? "320" : qi == 1 ? "192" : "128";
                switch (ext)
                {
                    case "mp3": sb.Append("-c:a libmp3lame -b:a " + kbps + "k "); break;
                    case "m4a": sb.Append("-c:a aac -b:a " + kbps + "k "); break;
                    case "wav": sb.Append("-c:a pcm_s16le "); break;
                    case "flac": sb.Append("-c:a flac "); break;
                }
                modeDesc = "重编码音频（" + (ext == "wav" || ext == "flac" ? "无损" : kbps + " kbps") + "，画质档选音质）";
                AppendLog("—— 格式转换：" + Path.GetFileName(src) + " → " + Path.GetFileName(fullOut) + "（" + modeDesc + "）");
            }

            sb.Append("-max_muxing_queue_size 4096 ");
            sb.Append("-progress pipe:1 ");
            sb.Append("-loglevel info ");
            sb.Append(U.Q(fullOut));

            Job job = new Job();
            job.Kind = 5;
            job.Video = src;
            job.Output = fullOut;
            job.VideoDuration = srcDur;

            StartFfmpegJob(sb.ToString(), job, new Action<JobResult>(OnCvDone), cvProgress, "转换中…");
        }

        private void OnCvDone(JobResult r)
        {
            if (r.Ok)
            {
                lblCvStatus.Text = "转换完成 ✓";
                AppendLog("完成：输出 " + U.FmtSize(r.Size) + "，时长 " + U.FmtTime(r.Duration));
                if (currentJob != null) AppendLog("文件已保存：" + currentJob.Output);
            }
            else if (r.Stopped)
            {
                lblCvStatus.Text = "已停止";
            }
            else
            {
                lblCvStatus.Text = "转换失败";
                AppendLog("[失败] " + r.Message);
                string hint = HintForFailure(r.Details);
                if (hint.Length > 0) AppendLog("[建议] " + hint);
            }
        }

        private void ProbeInfoLabel(string path, Label info)
        {
            if (info == null) return;
            if (path.Length == 0 || !File.Exists(path)) { info.Text = ""; return; }
            if (!Ffmpeg.ProbeReady) { info.Text = "未检测到 ffprobe，无法读取媒体信息"; return; }
            bool video = U.IsVideo(path);
            MediaInfo mi = Media.Probe(path, video);
            string s = "时长 " + U.FmtTime(mi.Duration) + " · " + (mi.Codec.Length > 0 ? mi.Codec : "未知编码");
            if (video && mi.Width > 0) s += " · " + mi.Width + "×" + mi.Height;
            try { s += " · " + U.FmtSize(new FileInfo(path).Length); }
            catch { }
            info.Text = s;
            info.ForeColor = CMuted;
        }

        private void SuggestExOut()
        {
            string src = txtExSrc.Text.Trim();
            if (src.Length == 0 || !File.Exists(src)) return;
            if (!chkExSame.Checked) return;
            string dir = Path.GetDirectoryName(src);
            if (string.IsNullOrEmpty(dir)) dir = U.ExeDir();
            string[] exts = new string[] { "mp3", "m4a", "wav", "flac", "ogg" };
            int i = cmbExFormat.SelectedIndex; if (i < 0) i = 0;
            txtExOut.Text = U.UniquePath(dir, Path.GetFileNameWithoutExtension(src) + "_音频", "." + exts[i]);
        }

        private void SuggestPicOut()
        {
            string src = txtPicSrc.Text.Trim();
            if (src.Length == 0 || !File.Exists(src)) return;
            if (!chkPicSame.Checked) return;
            string dir = Path.GetDirectoryName(src);
            if (string.IsNullOrEmpty(dir)) dir = U.ExeDir();
            string ext = (cmbPicFormat != null && cmbPicFormat.SelectedIndex == 1) ? ".mkv" : ".mp4";
            txtPicOut.Text = U.UniquePath(dir, Path.GetFileNameWithoutExtension(src) + "_画面", ext);
        }

        private static readonly string[] CvExt = new string[] { "mp4", "mkv", "mov", "avi", "webm", "mp3", "m4a", "wav", "flac", "gif" };

        private void SuggestCvOut()
        {
            string src = txtCvSrc.Text.Trim();
            if (src.Length == 0 || !File.Exists(src)) return;
            if (!chkCvSame.Checked) return;
            string dir = Path.GetDirectoryName(src);
            if (string.IsNullOrEmpty(dir)) dir = U.ExeDir();
            int i = cmbCvFormat.SelectedIndex; if (i < 0) i = 0;
            if (i >= CvExt.Length) i = 0;
            txtCvOut.Text = U.UniquePath(dir, Path.GetFileNameWithoutExtension(src) + "_转换", "." + CvExt[i]);
        }

        private void SuggestClipOut(bool force)
        {
            if (lstClips == null || lstClips.Items.Count == 0) return;
            string cur = txtClipOut.Text.Trim();
            if (!force && cur.Length > 0) return;
            string first = (string)lstClips.Items[0];
            string dir = Path.GetDirectoryName(first);
            if (string.IsNullOrEmpty(dir)) dir = U.ExeDir();
            string ext = (cmbClipFormat.SelectedIndex == 1) ? ".mkv" : ".mp4";
            txtClipOut.Text = U.UniquePath(dir, Path.GetFileNameWithoutExtension(first) + "_拼接", ext);
        }

        // ---------------- 启动 / 关闭 ----------------
        private void OnLoad(object sender, EventArgs e)
        {
            bool ok = Ffmpeg.Detect();
            if (ok)
            {
                AppendLog("ffmpeg：" + Ffmpeg.FfmpegPath);
                SetStatus("就绪", CText);
            }
            else
            {
                SetStatus("未找到 ffmpeg，点「指定 ffmpeg」手动选择", CErr);
                AppendLog("[错误] 未找到 ffmpeg.exe。请点击「指定 ffmpeg」按钮选择 ffmpeg.exe 的位置。");
                btnFindFfmpeg.Visible = true;
            }
            M3u8DL.Detect();
            if (M3u8DL.Ready)
            {
                AppendLog("N_m3u8DL-CLI：" + M3u8DL.ExePath);
                if (lblDlHint != null) lblDlHint.Text = "支持普通视频链接和 m3u8 地址。已检测到 N_m3u8DL-CLI，可直接下载 m3u8。";
            }
            else
            {
                if (lblDlHint != null) lblDlHint.Text = "支持普通视频链接和 m3u8 地址。未检测到 N_m3u8DL-CLI，可点击「指定 N_m3u8DL」手动选择，或放到程序目录/lib 中。";
                if (btnFindM3u8 != null) btnFindM3u8.Visible = true;
            }
            LoadDlHistoryUi();
            txtVideo.Focus();
        }

        private void OnClosed(object sender, FormClosedEventArgs e)
        {
            if (proc != null && running)
            {
                try { proc.Kill(); } catch { }
            }
            cutToken++;
            cutPrevToken++;
            ClearCutTempDir();
            picToken++;
            picFrameToken++;
            if (picFrameTimer != null) picFrameTimer.Stop();
            ClearPicTempDir();
        }

        // ---------------- 状态显示 ----------------
        private void SetStatus(string text, Color color)
        {
            lblStatus.Text = text;
            lblStatus.ForeColor = color;
        }

        private void AppendLog(string line)
        {
            string clean = line.Replace("\r", "").Replace("\n", "") + Environment.NewLine;
            if (txtLog.TextLength > 40000)
            {
                txtLog.Text = txtLog.Text.Substring(txtLog.TextLength - 12000);
            }
            txtLog.AppendText(clean);
            if (activeLog != null && activeLog != txtLog)
            {
                try
                {
                    if (activeLog.TextLength > 40000) activeLog.Text = activeLog.Text.Substring(activeLog.TextLength - 12000);
                    activeLog.AppendText(clean);
                }
                catch { }
            }
        }

        private void AppendLogBulk(string text)
        {
            if (txtLog.TextLength > 40000)
            {
                txtLog.Text = txtLog.Text.Substring(txtLog.TextLength - 12000);
            }
            txtLog.AppendText(text);
            if (activeLog != null && activeLog != txtLog)
            {
                try
                {
                    if (activeLog.TextLength > 40000) activeLog.Text = activeLog.Text.Substring(activeLog.TextLength - 12000);
                    activeLog.AppendText(text);
                }
                catch { }
            }
        }

        // ---------------- 文件选择 ----------------
        private void OnPickVideo(object sender, EventArgs e)
        {
            OpenFileDialog d = new OpenFileDialog();
            d.Title = "选择视频文件";
            d.Filter = "视频文件|*.mp4;*.mkv;*.mov;*.flv;*.avi;*.webm;*.ts;*.m4v;*.wmv;*.mpg;*.mpeg;*.3gp|所有文件|*.*";
            if (d.ShowDialog(this) == DialogResult.OK)
            {
                txtVideo.Text = d.FileName;
            }
        }

        private void OnPickAudio(object sender, EventArgs e)
        {
            OpenFileDialog d = new OpenFileDialog();
            d.Title = "选择音频文件";
            d.Filter = "音频文件|*.m4a;*.aac;*.mp3;*.wav;*.flac;*.ogg;*.opus;*.wma;*.ac3;*.eac3;*.amr;*.mka;*.ape|所有文件|*.*";
            if (d.ShowDialog(this) == DialogResult.OK)
            {
                txtAudio.Text = d.FileName;
            }
        }

        private void OnPickOut(object sender, EventArgs e)
        {
            SaveFileDialog d = new SaveFileDialog();
            d.Title = "指定输出文件";
            d.Filter = "MP4 视频|*.mp4|MKV 视频|*.mkv|所有文件|*.*";
            d.FileName = Path.GetFileName(txtOut.Text.Length > 0 ? txtOut.Text : "合并结果.mp4");
            string dir = txtOut.Text.Length > 0 ? Path.GetDirectoryName(txtOut.Text) : "";
            try { if (dir != null && dir.Length > 0) d.InitialDirectory = dir; }
            catch { }
            if (d.ShowDialog(this) == DialogResult.OK)
            {
                outManual = true;
                txtOut.Text = d.FileName;
                SyncFormatFromPath(d.FileName);
            }
        }

        private void SyncFormatFromPath(string p)
        {
            if (U.Ext(p) == "mkv") cmbFormat.SelectedIndex = 1;
            else cmbFormat.SelectedIndex = 0;
        }

        private void OnFindFfmpeg(object sender, EventArgs e)
        {
            OpenFileDialog d = new OpenFileDialog();
            d.Title = "选择 ffmpeg.exe";
            d.Filter = "ffmpeg.exe|ffmpeg.exe|可执行文件|*.exe";
            if (d.ShowDialog(this) == DialogResult.OK)
            {
                Cfg.Set("ffmpeg", d.FileName);
                Ffmpeg.FfmpegPath = d.FileName;
                string dir = Path.GetDirectoryName(d.FileName);
                string probe = Path.Combine(dir, "ffprobe.exe");
                if (File.Exists(probe)) Ffmpeg.FfprobePath = probe;
                btnFindFfmpeg.Visible = false;
                SetStatus("就绪", CText);
                AppendLog("已设置 ffmpeg：" + d.FileName);
                if (!Ffmpeg.ProbeReady) AppendLog("[提示] 同目录未找到 ffprobe.exe，文件时长信息将不可用（不影响合并）。");
            }
        }

        private void OnFindM3u8(object sender, EventArgs e)
        {
            OpenFileDialog d = new OpenFileDialog();
            d.Title = "选择 N_m3u8DL-CLI.exe";
            d.Filter = "N_m3u8DL-CLI|N_m3u8DL*.exe|可执行文件|*.exe";
            if (d.ShowDialog(this) == DialogResult.OK)
            {
                Cfg.Set("m3u8dl", d.FileName);
                M3u8DL.ExePath = d.FileName;
                M3u8DL.LastError = "";
                if (btnFindM3u8 != null) btnFindM3u8.Visible = false;
                AppendLog("已设置 N_m3u8DL-CLI：" + d.FileName);
                if (lblDlHint != null) lblDlHint.Text = "支持普通视频链接和 m3u8 地址。已检测到 N_m3u8DL-CLI，可直接下载 m3u8。";
            }
        }

        // ---------------- 拖拽 ----------------
        private void OnDragEnter(object sender, DragEventArgs e)
        {
            if (e.Data.GetDataPresent(DataFormats.FileDrop)) e.Effect = DragDropEffects.Copy;
            else e.Effect = DragDropEffects.None;
        }

        private void OnDragDrop(object sender, DragEventArgs e)
        {
            if (!e.Data.GetDataPresent(DataFormats.FileDrop)) return;
            string[] items = (string[])e.Data.GetData(DataFormats.FileDrop);
            if (items == null || items.Length == 0) return;

            if (items.Length == 1 && Directory.Exists(items[0]))
            {
                ScanFolder(items[0]);
                SwitchToBatchMode();
                return;
            }

            List<string> vids = new List<string>();
            List<string> auds = new List<string>();
            foreach (string p in items)
            {
                if (File.Exists(p))
                {
                    if (U.IsVideo(p)) vids.Add(p);
                    else if (U.IsAudio(p)) auds.Add(p);
                }
            }

            if (vids.Count + auds.Count > 2)
            {
                LoadBatchFromFiles(vids, auds);
                SwitchToBatchMode();
                return;
            }

            if (vids.Count > 0) txtVideo.Text = vids[0];
            if (auds.Count > 0) txtAudio.Text = auds[0];
            if (vids.Count == 0 && auds.Count == 1 && txtVideo.Text.Length > 0) txtAudio.Text = auds[0];
        }

        // ---------------- 输入变化 ----------------
        private void OnVideoChanged(object sender, EventArgs e)
        {
            SuggestOutput();
            UpdateSingleInfo(true);
        }

        private void OnAudioChanged(object sender, EventArgs e)
        {
            SuggestOutput();
            UpdateSingleInfo(false);
        }

        private void OnOutChanged(object sender, EventArgs e)
        {
            if (!suppressOut) outManual = true;
        }

        private void OnFormatChanged(object sender, EventArgs e)
        {
            string v = txtVideo.Text.Trim();
            if (txtOut.Text.Length > 0)
            {
                string target = Path.ChangeExtension(txtOut.Text, cmbFormat.SelectedIndex == 1 ? ".mkv" : ".mp4");
                if (target != txtOut.Text)
                {
                    suppressOut = true;
                    txtOut.Text = target;
                    suppressOut = false;
                }
            }
            else SuggestOutput();
            if (v.Length > 0) SuggestOutput();
        }

        private string ContainerName()
        {
            return cmbFormat.SelectedIndex == 1 ? "mkv" : "mp4";
        }

        private void SuggestOutput()
        {
            string v = txtVideo.Text.Trim();
            if (v.Length == 0) return;
            if (outManual && txtOut.Text.Trim().Length > 0) return;

            string dir = Path.GetDirectoryName(v);
            if (string.IsNullOrEmpty(dir)) dir = U.ExeDir();
            string ext = ContainerName() == "mkv" ? ".mkv" : ".mp4";
            string name = Path.GetFileNameWithoutExtension(v) + "_合并";
            string p = U.UniquePath(dir, name, ext);

            suppressOut = true;
            txtOut.Text = p;
            suppressOut = false;
        }

        private void UpdateSingleInfo(bool videoChanged)
        {
            if (!Ffmpeg.ProbeReady) return;

            if (videoChanged)
            {
                string v = txtVideo.Text.Trim();
                if (v.Length > 0 && File.Exists(v))
                {
                    MediaInfo mi = Media.Probe(v, true);
                    string s = "时长 " + U.FmtTime(mi.Duration) + " · " + (mi.Codec.Length > 0 ? mi.Codec : "未知编码");
                    if (mi.Width > 0) s += " · " + mi.Width + "×" + mi.Height;
                    s += " · " + U.FmtSize(new FileInfo(v).Length);
                    lblVideoInfo.Text = s;
                    lblVideoInfo.ForeColor = CMuted;
                }
                else lblVideoInfo.Text = "";
            }
            else
            {
                string a = txtAudio.Text.Trim();
                if (a.Length > 0 && File.Exists(a))
                {
                    MediaInfo mi = Media.Probe(a, false);
                    string s = "时长 " + U.FmtTime(mi.Duration) + " · " + (mi.Codec.Length > 0 ? mi.Codec : "未知编码");
                    s += " · " + U.FmtSize(new FileInfo(a).Length);
                    lblAudioInfo.Text = s;
                    lblAudioInfo.ForeColor = CMuted;
                }
                else lblAudioInfo.Text = "";
            }
            WarnCodecMismatch();
        }

        private void WarnCodecMismatch()
        {
            string a = txtAudio.Text.Trim();
            if (a.Length == 0 || !File.Exists(a)) return;
            if (!Ffmpeg.ProbeReady) return;
            if (ContainerName() != "mp4") return;
            if (!rdoCopy.Checked) return;

            string codec = "";
            try
            {
                MediaInfo mi = Media.Probe(a, false);
                codec = mi.Codec;
            }
            catch { }

            if (codec.Length > 0 && codec != "aac" && codec != "mp3" && codec != "ac3" && codec != "eac3")
            {
                lblAudioInfo.ForeColor = CErr;
                lblAudioInfo.Text = lblAudioInfo.Text + "   ← 这种音频放进 MP4 可能失败，建议选「音频转 AAC」";
            }
            else lblAudioInfo.ForeColor = CMuted;
        }

        // ---------------- 单个合并 ----------------
        private void SetBusy(bool busy)
        {
            btnStart.Enabled = !busy;
            btnPickVideo.Enabled = !busy;
            btnPickAudio.Enabled = !busy;
            btnPickOut.Enabled = !busy;
            cmbFormat.Enabled = !busy;
            rdoCopy.Enabled = !busy;
            rdoAac.Enabled = !busy;
            rdoReencode.Enabled = !busy;
            btnStop.Enabled = busy;
            txtVideo.Enabled = !busy;
            txtAudio.Enabled = !busy;
        }

        private void OnStart(object sender, EventArgs e)
        {
            if (running) return;
            if (batchRunning)
            {
                MessageBox.Show(this, "正在批量合并，请等它结束或切到批量模式后点停止。", "提示", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            if (!Ffmpeg.Ready)
            {
                MessageBox.Show(this, "还没有可用的 ffmpeg。请点「指定 ffmpeg」选择 ffmpeg.exe。", "缺少 ffmpeg", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                btnFindFfmpeg.Visible = true;
                return;
            }

            string v = txtVideo.Text.Trim();
            string a = txtAudio.Text.Trim();
            string o = txtOut.Text.Trim();

            if (v.Length == 0 || !File.Exists(v))
            {
                MessageBox.Show(this, "请先选择存在的视频文件。", "提示", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }
            if (a.Length == 0 || !File.Exists(a))
            {
                MessageBox.Show(this, "请先选择存在的音频文件。", "提示", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }
            if (o.Length == 0)
            {
                MessageBox.Show(this, "请指定输出文件。", "提示", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }

            string fullOut = Path.GetFullPath(o);
            if (fullOut.ToLowerInvariant() == Path.GetFullPath(v).ToLowerInvariant() ||
                fullOut.ToLowerInvariant() == Path.GetFullPath(a).ToLowerInvariant())
            {
                MessageBox.Show(this, "输出文件不能和源文件同名，否则会覆盖原始文件。请换个输出文件名。", "提示", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }

            string dir = Path.GetDirectoryName(fullOut);
            if (dir == null || !Directory.Exists(dir))
            {
                MessageBox.Show(this, "输出文件夹不存在：" + dir, "提示", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }
            if (U.Ext(fullOut) != "mp4" && U.Ext(fullOut) != "mkv")
            {
                MessageBox.Show(this, "输出文件扩展名只能是 .mp4 或 .mkv。", "提示", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }

            int mode = 0;
            if (rdoAac.Checked) mode = 1;
            if (rdoReencode.Checked) mode = 2;

            Job job = new Job();
            job.Video = v;
            job.Audio = a;
            job.Output = fullOut;
            job.Mode = mode;
            job.Container = ContainerName();
            job.Shortest = chkShortest.Checked;

            MediaInfo vmi = new MediaInfo();
            try { vmi = Media.Probe(v, true); }
            catch { }
            job.VideoDuration = vmi.Duration;

            batchRunning = false;
            StartMerge(job, new Action<JobResult>(OnSingleDone));
        }

        private void OnSingleDone(JobResult r)
        {
            if (r.Ok)
            {
                SetStatus("合并完成 ✓", COk);
                AppendLog("完成：输出 " + U.FmtSize(r.Size) + "，时长 " + U.FmtTime(r.Duration));
                if (chkOpenFolder.Checked) OpenFolder(Path.GetDirectoryName(currentJob.Output));
            }
            else if (r.Stopped)
            {
                SetStatus("已停止", CErr);
            }
            else
            {
                SetStatus("合并失败", CErr);
                AppendLog("[失败] " + r.Message);
                string hint = HintForFailure(r.Details);
                if (hint.Length > 0) AppendLog("[建议] " + hint);
            }
        }

        private string HintForFailure(string details)
        {
            string d = (details == null ? "" : details).ToLowerInvariant();
            if (d.IndexOf("codec") >= 0 && d.IndexOf("not currently supported in container") >= 0)
                return "音频/视频编码和当前容器不兼容，请把「合并方式」改成「音频转 AAC」或「全部重编码」再试。";
            if (d.IndexOf("invalid data found") >= 0 || d.IndexOf("moov atom not found") >= 0)
                return "源文件可能没下载完整或不是标准媒体文件，请检查文件是否损坏。";
            if (d.IndexOf("permission denied") >= 0 || d.IndexOf("could not open") >= 0)
                return "文件可能被其他程序占用，或没有写入权限，请关闭占用它的程序后重试。";
            if (d.IndexOf("no such file") >= 0)
                return "文件路径不存在或含有特殊字符，请重新选择文件。";
            return "把「合并方式」换成「全部重编码」通常能解决兼容性问题。完整原因见日志。";
        }

        // ---------------- 批量 ----------------
        private void OnScanFolder(object sender, EventArgs e)
        {
            FolderBrowserDialog d = new FolderBrowserDialog();
            d.Description = "选择包含视频和音频的文件夹（只扫描这一层，不递归子文件夹）";
            if (d.ShowDialog(this) == DialogResult.OK) ScanFolder(d.SelectedPath);
        }

        private void ScanFolder(string dir)
        {
            if (running) { MessageBox.Show(this, "正在合并，请先等当前任务结束或点停止。", "提示", MessageBoxButtons.OK, MessageBoxIcon.Information); return; }
            if (!Directory.Exists(dir)) return;

            List<string> vids = new List<string>();
            List<string> auds = new List<string>();
            try
            {
                string[] files = Directory.GetFiles(dir);
                foreach (string f in files)
                {
                    if (U.IsVideo(f)) vids.Add(f);
                    else if (U.IsAudio(f)) auds.Add(f);
                }
            }
            catch (Exception ex)
            {
                MessageBox.Show(this, "读取文件夹失败：" + ex.Message, "提示", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }

            if (vids.Count == 0)
            {
                lblScanInfo.Text = "这个文件夹里没有发现视频文件（MP4/MKV/MOV 等）。";
                lblScanInfo.ForeColor = CErr;
                return;
            }

            StartBatchMatch(vids, auds, "扫描目录：" + dir + " → " + vids.Count + " 视频 / " + auds.Count + " 音频（按文件名 + 时长配对）");
        }

        private void LoadBatchFromFiles(List<string> vids, List<string> auds)
        {
            StartBatchMatch(vids, auds, "已从拖入的文件按「文件名 + 时长」配对：" + vids.Count + " 视频 / " + auds.Count + " 音频");
        }

        private void OnBatchItemCheck(object sender, ItemCheckEventArgs e)
        {
            if (e.Index < 0 || e.Index >= lvBatch.Items.Count) return;
            object tag = lvBatch.Items[e.Index].Tag;
            if (tag is BatchItem) ((BatchItem)tag).Checked = (e.NewValue == CheckState.Checked);
        }

        // ---------------- 批量配对（文件名 + 时长） ----------------

        // 建行并后台探测时长，然后按「文件名相似度 + 时长接近度」自动配对
        private void StartBatchMatch(List<string> vids, List<string> auds, string introLog)
        {
            lvBatch.Items.Clear();
            batchItems.Clear();
            batchIndex = -1;

            foreach (string v in vids)
            {
                BatchItem it = new BatchItem();
                it.Video = v;
                it.Status = "配对中…";
                ListViewItem row = new ListViewItem(Path.GetFileName(v));
                row.SubItems.Add("—");
                row.SubItems.Add("读取中…");
                row.SubItems.Add("—");
                row.SubItems.Add(it.Status);
                row.Checked = false;
                row.Tag = it;
                it.Row = row;
                lvBatch.Items.Add(row);
                batchItems.Add(it);
            }

            lblScanInfo.ForeColor = CMuted;
            lblScanInfo.Text = "发现 " + vids.Count + " 个视频、" + auds.Count + " 个音频，正在读取时长并配对…";
            AppendLog(introLog);

            probeToken++;
            int token = probeToken;
            ThreadPool.QueueUserWorkItem(new WaitCallback(delegate(object state)
            {
                RunBatchMatch(token, vids, auds);
            }));
        }

        private void ReportScanProgress(int token, int done, int total)
        {
            try
            {
                this.BeginInvoke(new MethodInvoker(delegate()
                {
                    if (token != probeToken) return;
                    lblScanInfo.Text = "正在读取时长并配对… (" + done + "/" + total + ")";
                }));
            }
            catch { }
        }

        private void RunBatchMatch(int token, List<string> vids, List<string> auds)
        {
            // 1) 探测各文件时长（不可探测时退回按修改时间配对）
            Dictionary<string, double> vDur = new Dictionary<string, double>();
            Dictionary<string, double> aDur = new Dictionary<string, double>();
            Dictionary<string, DateTime> vTime = new Dictionary<string, DateTime>();
            Dictionary<string, DateTime> aTime = new Dictionary<string, DateTime>();

            int total = vids.Count + auds.Count;
            int done = 0;

            foreach (string v in vids)
            {
                double d = 0;
                if (Ffmpeg.ProbeReady) { try { MediaInfo mi = Media.Probe(v, true); d = mi.Duration; } catch { } }
                try { vTime[v] = File.GetLastWriteTime(v); } catch { }
                vDur[v] = d;
                done++;
                if (token != probeToken) return;
                ReportScanProgress(token, done, total);
            }
            foreach (string a in auds)
            {
                double d = 0;
                if (Ffmpeg.ProbeReady) { try { MediaInfo mi = Media.Probe(a, false); d = mi.Duration; } catch { } }
                try { aTime[a] = File.GetLastWriteTime(a); } catch { }
                aDur[a] = d;
                done++;
                if (token != probeToken) return;
                ReportScanProgress(token, done, total);
            }

            // 2) 打分并贪心配对
            string[] assign;
            double[] nameScores;
            MatchVidAuds(vids, auds, vDur, aDur, vTime, aTime, out assign, out nameScores);

            // 3) 回 UI 线程填充结果
            try
            {
                this.BeginInvoke(new MethodInvoker(delegate()
                {
                    if (token != probeToken) return;
                    int pairs = 0;
                    for (int i = 0; i < batchItems.Count && i < vids.Count; i++)
                    {
                        BatchItem b = batchItems[i];
                        if (b == null) continue;
                        b.Audio = assign[i];
                        b.NameScore = nameScores[i];
                        if (vDur.ContainsKey(b.Video)) b.VDur = vDur[b.Video];
                        if (b.Audio.Length > 0 && aDur.ContainsKey(b.Audio)) b.ADur = aDur[b.Audio];
                        RefreshBatchRow(b);
                        if (b.Audio.Length > 0) pairs++;
                    }
                    int extra = auds.Count - pairs;
                    lblScanInfo.ForeColor = CMuted;
                    lblScanInfo.Text = "共 " + vids.Count + " 个视频、" + auds.Count + " 个音频，已配对 " + pairs + " 组"
                        + (extra > 0 ? "，还有 " + extra + " 个音频未配对（可手动拖动调整）" : "")
                        + "。核对后点「开始批量合并」。";
                    AppendLog("自动配对完成（文件名 + 时长）：共 " + pairs + " 组"
                        + (extra > 0 ? "，" + extra + " 个音频未用上，可手动拖到某一行" : ""));
                }));
            }
            catch { }
        }

        // 「文件名 + 时长」结合的配对打分
        //  总分 = 名称相似度×0.70 + 时长接近度×0.25 + 修改时间接近度×0.05
        //  时长读取失败时，时长项改用修改时间；名称完全一致的配对几乎必然排在最前
        private void MatchVidAuds(List<string> vids, List<string> auds,
            Dictionary<string, double> vDur, Dictionary<string, double> aDur,
            Dictionary<string, DateTime> vTime, Dictionary<string, DateTime> aTime,
            out string[] assign, out double[] nameScores)
        {
            int n = vids.Count, m = auds.Count;
            assign = new string[n];
            nameScores = new double[n];
            bool[] vUsed = new bool[n];
            bool[] aUsed = new bool[m];

            List<double[]> cand = new List<double[]>(); // {视频序号, 音频序号, 总分, 名称分}
            for (int i = 0; i < n; i++)
            {
                string vn = U.NormName(vids[i]);
                double vd = vDur.ContainsKey(vids[i]) ? vDur[vids[i]] : 0;
                DateTime vt = vTime.ContainsKey(vids[i]) ? vTime[vids[i]] : DateTime.MinValue;
                for (int j = 0; j < m; j++)
                {
                    string an = U.NormName(auds[j]);
                    double ns = U.NameSim(vn, an);
                    double ad = aDur.ContainsKey(auds[j]) ? aDur[auds[j]] : 0;

                    double ds;   // 时长接近度
                    if (vd > 0 && ad > 0) ds = 1.0 / (1.0 + Math.Abs(vd - ad) / 4.0);
                    else ds = -1;                    // 读取失败，用修改时间代替
                    DateTime at = aTime.ContainsKey(auds[j]) ? aTime[auds[j]] : DateTime.MinValue;
                    double mt = 0;                   // 修改时间接近度
                    if (vt != DateTime.MinValue && at != DateTime.MinValue)
                        mt = 1.0 / (1.0 + Math.Abs((vt - at).TotalSeconds) / 300.0);

                    double score = ns * 0.70 + (ds > 0 ? ds : mt) * 0.25 + mt * 0.05;
                    cand.Add(new double[] { i, j, score, ns });
                }
            }

            cand.Sort(delegate(double[] x, double[] y) { return y[2].CompareTo(x[2]); });
            foreach (double[] c in cand)
            {
                int i = (int)c[0], j = (int)c[1];
                if (vUsed[i] || aUsed[j]) continue;
                vUsed[i] = true;
                aUsed[j] = true;
                assign[i] = auds[j];
                nameScores[i] = c[3];
            }
        }

        // ---------------- 批量列表：手动拖动调整配对 ----------------

        private ListViewItem hiRow = null;

        private void OnBatchItemDrag(object sender, ItemDragEventArgs e)
        {
            if (batchRunning || running) return;
            ListViewItem row = e.Item as ListViewItem;
            BatchItem it = row == null ? null : row.Tag as BatchItem;
            if (it == null || string.IsNullOrEmpty(it.Audio)) return;

            DataObject d = new DataObject();
            d.SetData("BatchAudioDrag", it);
            lvBatch.DoDragDrop(d, DragDropEffects.Move);
        }

        private BatchItem HitBatchRow(int x, int y)
        {
            ListViewHitTestInfo h = lvBatch.HitTest(lvBatch.PointToClient(new Point(x, y)));
            return h.Item == null ? null : h.Item.Tag as BatchItem;
        }

        private void HiBatchRow(BatchItem it)
        {
            ListViewItem row = it == null ? null : it.Row;
            if (row == null || hiRow == row) return;
            ClearHiBatchRow();
            hiRow = row;
            hiRow.BackColor = Color.FromArgb(224, 238, 252);
        }

        private void ClearHiBatchRow()
        {
            if (hiRow != null)
            {
                hiRow.BackColor = Color.Empty;
                hiRow = null;
            }
        }

        private void OnBatchListDragOver(object sender, DragEventArgs e)
        {
            BatchItem target = HitBatchRow(e.X, e.Y);

            BatchItem src = e.Data.GetDataPresent("BatchAudioDrag")
                ? e.Data.GetData("BatchAudioDrag") as BatchItem : null;
            if (src != null)
            {
                if (target == null || src == target)
                {
                    ClearHiBatchRow();
                    e.Effect = DragDropEffects.None;
                    return;
                }
                e.Effect = batchRunning || running ? DragDropEffects.None : DragDropEffects.Move;
                if (e.Effect != DragDropEffects.None) HiBatchRow(target);
                return;
            }

            if (e.Data.GetDataPresent(DataFormats.FileDrop))
            {
                string[] paths = (string[])e.Data.GetData(DataFormats.FileDrop);
                bool hasAudio = false;
                if (paths != null) foreach (string p in paths) { if (File.Exists(p) && U.IsAudio(p)) { hasAudio = true; break; } }
                if (!hasAudio || batchRunning || running)
                {
                    ClearHiBatchRow();
                    e.Effect = DragDropEffects.None;
                    return;
                }
                e.Effect = DragDropEffects.Copy;
                if (target != null) HiBatchRow(target);
                return;
            }

            ClearHiBatchRow();
            e.Effect = DragDropEffects.None;
        }

        private void OnBatchListDragLeave(object sender, EventArgs e)
        {
            ClearHiBatchRow();
        }

        private void OnBatchListDragDrop(object sender, DragEventArgs e)
        {
            ClearHiBatchRow();
            if (batchRunning || running) return;

            BatchItem target = HitBatchRow(e.X, e.Y);

            // 列表内部拖动：把源行音频移/换到目标行
            BatchItem src = e.Data.GetDataPresent("BatchAudioDrag")
                ? e.Data.GetData("BatchAudioDrag") as BatchItem : null;
            if (src != null)
            {
                if (target != null) MoveBatchAudio(src, target);
                return;
            }

            // 外部文件拖入
            if (!e.Data.GetDataPresent(DataFormats.FileDrop)) return;
            string[] items = (string[])e.Data.GetData(DataFormats.FileDrop);
            if (items == null || items.Length == 0) return;

            if (items.Length == 1 && Directory.Exists(items[0]))
            {
                ScanFolder(items[0]);
                SwitchToBatchMode();
                return;
            }

            List<string> vids = new List<string>();
            List<string> auds = new List<string>();
            foreach (string p in items)
            {
                if (File.Exists(p))
                {
                    if (U.IsVideo(p)) vids.Add(p);
                    else if (U.IsAudio(p)) auds.Add(p);
                }
            }

            // 拖到某一行的音频文件：从该行起顺次为各行指定音频
            if (target != null)
            {
                int ti = batchItems.IndexOf(target);
                int given = 0;
                foreach (string a in auds)
                {
                    if (ti < 0 || ti >= batchItems.Count) break;
                    AssignAudio(batchItems[ti], a);
                    ti++;
                    given++;
                }
                return;
            }

            // 拖到空白处
            if (batchItems.Count == 0)
            {
                if (vids.Count + auds.Count > 2)
                {
                    LoadBatchFromFiles(vids, auds);
                    SwitchToBatchMode();
                }
                else if (vids.Count + auds.Count > 0)
                {
                    if (vids.Count > 0) txtVideo.Text = vids[0];
                    if (auds.Count > 0) txtAudio.Text = auds[0];
                }
                return;
            }

            // 已有列表：把拖入的音频补给还缺音频的行
            int filled = 0;
            foreach (string a in auds)
            {
                BatchItem slot = null;
                foreach (BatchItem b in batchItems) { if (string.IsNullOrEmpty(b.Audio)) { slot = b; break; } }
                if (slot == null) break;
                AssignAudio(slot, a);
                filled++;
            }
            if (filled > 0) AppendLog("拖入 " + filled + " 个音频，已补到缺少音频的行上。");
        }

        // 把源行音频移到目标行；目标行已有音频则两行交换
        private void MoveBatchAudio(BatchItem src, BatchItem dst)
        {
            if (src == null || dst == null || src == dst || batchRunning || running) return;
            if (string.IsNullOrEmpty(src.Audio)) return;

            string sAudio = src.Audio; double sDur = src.ADur; double sScore = src.NameScore;
            if (!string.IsNullOrEmpty(dst.Audio))
            {
                src.Audio = dst.Audio; src.ADur = dst.ADur; src.NameScore = dst.NameScore;
            }
            else
            {
                src.Audio = ""; src.ADur = 0; src.NameScore = 0;
            }
            dst.Audio = sAudio; dst.ADur = sDur; dst.NameScore = sScore;
            if (!string.IsNullOrEmpty(dst.Audio))
                dst.NameScore = U.NameSim(U.NormName(dst.Video), U.NormName(dst.Audio));
            if (!string.IsNullOrEmpty(src.Audio))
                src.NameScore = U.NameSim(U.NormName(src.Video), U.NormName(src.Audio));

            RefreshBatchRow(src);
            RefreshBatchRow(dst);
            AppendLog("手动调整：视频「" + Path.GetFileName(dst.Video) + "」配音频「"
                + (string.IsNullOrEmpty(dst.Audio) ? "（无）" : Path.GetFileName(dst.Audio)) + "」");
        }

        // 为某一行指定（替换）音频文件
        private void AssignAudio(BatchItem it, string audio)
        {
            if (it == null || string.IsNullOrEmpty(audio) || batchRunning || running) return;
            if (string.Equals(it.Audio, audio, StringComparison.OrdinalIgnoreCase)) return;
            it.Audio = audio;
            it.ADur = 0;
            it.NameScore = U.NameSim(U.NormName(it.Video), U.NormName(audio));
            RefreshBatchRow(it);
            ProbeOne(it);
            AppendLog("手动指定：视频「" + Path.GetFileName(it.Video) + "」 ⇐ 音频「" + Path.GetFileName(audio) + "」");
        }

        // 单独刷新某一行的音频时长（后台探测）
        private void ProbeOne(BatchItem it)
        {
            if (!Ffmpeg.ProbeReady) return;
            BatchItem cap = it;
            ThreadPool.QueueUserWorkItem(new WaitCallback(delegate(object state)
            {
                double vd = 0, ad = 0;
                try { if (cap.Video.Length > 0) { MediaInfo mi = Media.Probe(cap.Video, true); vd = mi.Duration; } } catch { }
                try { if (cap.Audio.Length > 0) { MediaInfo mi = Media.Probe(cap.Audio, false); ad = mi.Duration; } } catch { }
                try
                {
                    this.BeginInvoke(new MethodInvoker(delegate()
                    {
                        if (cap.Row == null || batchItems.IndexOf(cap) < 0) return;
                        cap.VDur = vd;
                        cap.ADur = ad;
                        RefreshBatchRow(cap);
                    }));
                }
                catch { }
            }));
        }

        // 按当前数据刷新某一行显示 + 状态文字
        private void RefreshBatchRow(BatchItem it)
        {
            if (it == null || it.Row == null) return;
            it.Row.SubItems[1].Text = string.IsNullOrEmpty(it.Audio) ? "—" : Path.GetFileName(it.Audio);
            if (it.VDur > 0) it.Row.SubItems[2].Text = U.FmtTime(it.VDur);
            it.Row.SubItems[3].Text = it.ADur > 0 ? U.FmtTime(it.ADur) : "—";
            SetBatchStatusText(it);
            it.Row.Checked = !string.IsNullOrEmpty(it.Audio);
        }

        private void SetBatchStatusText(BatchItem it)
        {
            string s;
            if (string.IsNullOrEmpty(it.Audio)) s = "没有可配对的音频";
            else
            {
                List<string> warn = new List<string>();
                if (it.VDur > 0 && it.ADur > 0 && Math.Abs(it.VDur - it.ADur) > 5)
                    warn.Add("时长差 " + U.FmtTime(Math.Abs(it.VDur - it.ADur)));
                if (it.NameScore > 0 && it.NameScore < 0.55) warn.Add("名称不像");
                s = warn.Count > 0 ? string.Join("，", warn.ToArray()) + "，请核对" : "待合并";
            }
            it.Status = s;
            if (it.Row != null) it.Row.SubItems[4].Text = s;
        }

        private void OnBatchStart(object sender, EventArgs e)
        {
            if (running) return;
            if (batchRunning)
            {
                MessageBox.Show(this, "正在批量合并，请等它结束或切到批量模式后点停止。", "提示", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            if (!Ffmpeg.Ready)
            {
                MessageBox.Show(this, "还没有可用的 ffmpeg。请切到单个合并模式点「指定 ffmpeg」。", "缺少 ffmpeg", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }
            if (batchItems.Count == 0)
            {
                MessageBox.Show(this, "请先扫描一个文件夹，或把文件拖进来。", "提示", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }

            int checkedCount = 0;
            foreach (BatchItem it in batchItems) if (it.Checked && it.Audio.Length > 0) checkedCount++;
            if (checkedCount == 0)
            {
                MessageBox.Show(this, "没有可执行的任务：请勾选至少一行，且该行要有配对音频。", "提示", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }

            foreach (BatchItem it in batchItems)
            {
                it.Done = false;
                if (it.Audio.Length > 0 && it.Checked) { it.Status = "待合并"; if (it.Row != null) it.Row.SubItems[4].Text = "待合并"; }
            }

            batchRunning = true;
            batchIndex = -1;
            btnBatchStart.Enabled = false;
            btnScan.Enabled = false;
            cmbBatchFormat.Enabled = false;
            cmbBatchMode.Enabled = false;
            btnBatchStop.Enabled = true;
            SetStatus("批量合并中…", CAccent);
            AppendLog("开始批量合并，共 " + checkedCount + " 组");

            StartNextBatchItem();
        }

        private void StartNextBatchItem()
        {
            if (!batchRunning) return;

            for (batchIndex++; batchIndex < batchItems.Count; batchIndex++)
            {
                BatchItem it = batchItems[batchIndex];
                if (!it.Checked || it.Audio.Length == 0 || it.Done) continue;

                string dir = Path.GetDirectoryName(it.Video);
                if (string.IsNullOrEmpty(dir)) dir = U.ExeDir();
                string ext = cmbBatchFormat.SelectedIndex == 1 ? ".mkv" : ".mp4";
                string name = Path.GetFileNameWithoutExtension(it.Video) + "_合并";
                string outp = U.UniquePath(dir, name, ext);

                Job job = new Job();
                job.Video = it.Video;
                job.Audio = it.Audio;
                job.Output = outp;
                job.Mode = cmbBatchMode.SelectedIndex;
                job.Container = ext == ".mkv" ? "mkv" : "mp4";
                job.Shortest = chkBatchShortest.Checked;
                job.VideoDuration = it.VDur;

                if (it.Row != null) it.Row.SubItems[4].Text = "合并中…";
                AppendLog("—— [" + (batchIndex + 1) + "/" + batchItems.Count + "] " + Path.GetFileName(it.Video));
                SetStatus("批量合并中 (" + (batchIndex + 1) + "/" + batchItems.Count + ")", CAccent);

                StartMerge(job, new Action<JobResult>(OnBatchItemDone));
                return;
            }

            // 全部结束
            batchRunning = false;
            btnBatchStart.Enabled = true;
            btnScan.Enabled = true;
            cmbBatchFormat.Enabled = true;
            cmbBatchMode.Enabled = true;
            btnBatchStop.Enabled = false;
            progressBatch.Value = 100;
            SetBusy(false);
            SetStatus("批量合并结束", COk);
            lblBatchStatus.Text = "全部结束";
            AppendLog("批量合并结束");
        }

        private void OnBatchItemDone(JobResult r)
        {
            if (batchIndex >= 0 && batchIndex < batchItems.Count)
            {
                BatchItem it = batchItems[batchIndex];
                it.Done = true;
                if (it.Row != null)
                {
                    if (r.Ok) it.Row.SubItems[4].Text = "完成 ✓ " + U.FmtSize(r.Size);
                    else if (r.Stopped) it.Row.SubItems[4].Text = "已停止";
                    else it.Row.SubItems[4].Text = "失败：" + r.Message;
                }
                AppendLog("    " + (r.Ok ? "成功" : (r.Stopped ? "已停止" : "失败 " + r.Message)));
            }

            if (r.Stopped) { StopBatch(); return; }

            int total = 0;
            foreach (BatchItem b in batchItems) if (b.Checked && b.Audio.Length > 0) total++;
            int finished = 0;
            foreach (BatchItem b in batchItems) if (b.Checked && b.Audio.Length > 0 && b.Done) finished++;
            if (total > 0) progressBatch.Value = Math.Min(100, (int)(finished * 100.0 / total));
            lblBatchStatus.Text = finished + " / " + total;

            StartNextBatchItem();
        }

        private void StopBatch()
        {
            batchRunning = false;
            btnBatchStart.Enabled = true;
            btnScan.Enabled = true;
            cmbBatchFormat.Enabled = true;
            cmbBatchMode.Enabled = true;
            btnBatchStop.Enabled = false;
            SetBusy(false);
            SetStatus("已停止", CErr);
            AppendLog("批量合并已停止");
        }

        // ---------------- 合并执行 ----------------
        private string BuildArgs(Job job)
        {
            StringBuilder sb = new StringBuilder();
            sb.Append("-hide_banner -nostats -y ");
            sb.Append("-i " + U.Q(job.Video) + " ");
            if (job.Audio.Length > 0) sb.Append("-i " + U.Q(job.Audio) + " ");
            if (job.Audio.Length > 0) sb.Append("-map 0:v:0 -map 1:a:0 ");
            else sb.Append("-map 0:v:0 -map 0:a:0? ");

            if (job.Mode == 0)
            {
                sb.Append("-c:v copy -c:a copy ");
            }
            else if (job.Mode == 1)
            {
                sb.Append("-c:v copy -c:a aac -b:a 192k ");
            }
            else
            {
                sb.Append("-c:v libx264 -preset veryfast -crf 20 -pix_fmt yuv420p -c:a aac -b:a 192k ");
            }

            if (job.Container == "mp4") sb.Append("-movflags +faststart ");
            if (job.Shortest) sb.Append("-shortest ");
            sb.Append("-max_muxing_queue_size 4096 ");
            sb.Append("-progress pipe:1 ");
            sb.Append("-loglevel info ");
            sb.Append(U.Q(job.Output));
            return sb.ToString();
        }

        private void StartMerge(Job job, Action<JobResult> done)
        {
            StartFfmpegJob(BuildArgs(job), job, done, progress, "合并中…");
        }

        // 通用任务执行（合并 / 提取 / 下载等共用）
        private void StartFfmpegJob(string args, Job job, Action<JobResult> done, ProgressBar prog, string runningText)
        {
            currentJob = job;
            onDone = done;
            stopRequested = false;
            lastUs = 0;
            startedAt = DateTime.Now;

            lock (queueLock) { outQueue.Clear(); errQueue.Clear(); }
            errTail = new List<string>();

            jobProg = prog != null ? prog : progress;
            jobRunningText = runningText != null ? runningText : "处理中…";
            if (jobProg == exProgress) activeLog = exLog;
            else if (jobProg == cutProgress) activeLog = cutLog;
            else if (jobProg == clipProgress) activeLog = clipLog;
            else if (jobProg == picProgress) activeLog = picLog;
            else if (jobProg == cvProgress) activeLog = cvLog;
            else if (dlProgress != null && jobProg == dlProgress) activeLog = dlLog;
            else activeLog = txtLog;

            job.OutputExistedBefore = File.Exists(job.Output);

            string exePath = (job != null && job.Exe != null && job.Exe.Length > 0) ? job.Exe : Ffmpeg.FfmpegPath;
            string exeName = Path.GetFileName(exePath);
            if (string.IsNullOrEmpty(exeName)) exeName = "tool";
            AppendLog("> " + exeName + " " + args);

            ProcessStartInfo psi = new ProcessStartInfo(exePath, args);
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            bool m3u8Tool = (job != null && job.Kind == 6 && job.Exe != null && job.Exe.Length > 0 && job.Exe.IndexOf("m3u8", StringComparison.OrdinalIgnoreCase) >= 0);
            if (m3u8Tool)
            {
                try { psi.StandardOutputEncoding = Encoding.GetEncoding(936); psi.StandardErrorEncoding = Encoding.GetEncoding(936); }
                catch { psi.StandardOutputEncoding = Encoding.UTF8; psi.StandardErrorEncoding = Encoding.UTF8; }
            }
            else
            {
                psi.StandardOutputEncoding = Encoding.UTF8;
                psi.StandardErrorEncoding = Encoding.UTF8;
            }
            string wd = "";
            try { wd = Path.GetDirectoryName(job.Output); } catch { }
            if (string.IsNullOrEmpty(wd) || !Directory.Exists(wd)) wd = U.ExeDir();
            psi.WorkingDirectory = wd;

            Process p;
            try { p = new Process(); p.StartInfo = psi; }
            catch (Exception ex)
            {
                activeLog = null;
                JobResult r = new JobResult();
                r.Message = "启动 ffmpeg 失败：" + ex.Message;
                if (done != null) done(r);
                return;
            }

            proc = p;
            psiCurrent = psi;
            running = true;
            jobProg.Value = 0;
            jobProg.Style = job.VideoDuration > 0 ? ProgressBarStyle.Continuous : ProgressBarStyle.Marquee;
            SetBusy(true);
            SetStatus(jobRunningText, CAccent);

            p.OutputDataReceived += new DataReceivedEventHandler(OnFfmpegOut);
            p.ErrorDataReceived += new DataReceivedEventHandler(OnFfmpegErr);

            try
            {
                p.Start();
                p.BeginOutputReadLine();
                p.BeginErrorReadLine();
            }
            catch (Exception ex)
            {
                running = false;
                proc = null;
                SetBusy(false);
                activeLog = null;
                JobResult r = new JobResult();
                r.Message = "启动 ffmpeg 失败：" + ex.Message;
                AppendLog("[失败] " + r.Message);
                if (done != null) done(r);
                return;
            }

            ticker.Start();
        }

        private void OnFfmpegOut(object sender, DataReceivedEventArgs e)
        {
            if (e.Data == null) return;
            lock (queueLock) { outQueue.Add(e.Data); }
        }

        private void OnFfmpegErr(object sender, DataReceivedEventArgs e)
        {
            if (e.Data == null) return;
            lock (queueLock) { errQueue.Add(e.Data); }
        }

        private void DrainQueues()
        {
            List<string> outs = new List<string>();
            List<string> errs = new List<string>();
            lock (queueLock)
            {
                outs.AddRange(outQueue); outQueue.Clear();
                errs.AddRange(errQueue); errQueue.Clear();
            }

            StringBuilder shown = new StringBuilder();
            foreach (string line in outs)
            {
                string t = line.Trim();
                if (t.StartsWith("out_time_us="))
                {
                    try { lastUs = long.Parse(t.Substring("out_time_us=".Length).Trim()); }
                    catch { }
                    continue;
                }
                if (t.StartsWith("progress=")) continue;
                if (t.StartsWith("frame=") || t.StartsWith("fps=") || t.StartsWith("bitrate=") ||
                    t.StartsWith("total_size=") || t.StartsWith("out_time_ms=") || t.StartsWith("out_time=") ||
                    t.StartsWith("dup_frames=") || t.StartsWith("drop_frames=") || t.StartsWith("speed=") ||
                    t.StartsWith("stream_") || t.StartsWith("q=")) continue;
                if (t.Length > 0) shown.Append(t).Append(Environment.NewLine);
            }

            foreach (string line in errs)
            {
                string t = line.TrimEnd();
                if (t.Length == 0) continue;
                if (t.IndexOf("frame=") == 0 || t.IndexOf("size=") == 0) continue;
                shown.Append(t).Append(Environment.NewLine);
                errTail.Add(t);
                if (errTail.Count > 200) errTail.RemoveAt(0);
            }

            if (shown.Length > 0) AppendLogBulk(shown.ToString());
        }

        private void OnTick(object sender, EventArgs e)
        {
            DrainQueues();

            if (!running || proc == null) return;

            if (proc.HasExited)
            {
                CompleteJob();
                return;
            }

            if (currentJob != null && currentJob.VideoDuration > 0 && jobProg != null && jobProg.Style == ProgressBarStyle.Continuous)
            {
                double pct = (lastUs / 1000000.0) / currentJob.VideoDuration * 100.0;
                if (pct < 0) pct = 0;
                if (pct > 99.5) pct = 99;
                jobProg.Value = (int)pct;
                int elapsed = (int)(DateTime.Now - startedAt).TotalSeconds;
                SetStatus(jobRunningText + " " + (int)pct + "%  (" + U.FmtTime(elapsed) + ")", CAccent);
            }
        }

        private void CompleteJob()
        {
            running = false;
            ticker.Stop();

            Process p = proc;
            proc = null;

            int code = -1;
            try
            {
                p.WaitForExit(3000);
                code = p.ExitCode;
            }
            catch { }

            DrainQueues();

            Job job = currentJob;
            JobResult r = new JobResult();
            r.ExitCode = code;
            r.Stopped = stopRequested;

            int kind = job != null ? job.Kind : 0;
            string word = kind == 1 ? "提取" : kind == 2 ? "剪辑" : kind == 3 ? "拼接" : kind == 4 ? "画面调整" : kind == 5 ? "转换" : kind == 6 ? "下载" : "合并";

            bool fileOk = false;
            long size = 0;
            if (job != null && File.Exists(job.Output))
            {
                size = new FileInfo(job.Output).Length;
                fileOk = size > 0;
            }

            if (code == 0 && fileOk)
            {
                r.Ok = true;
                r.Size = size;
                try { r.Duration = Media.Probe(job.Output, kind != 1).Duration; } catch { }
                if (jobProg != null)
                {
                    jobProg.Style = ProgressBarStyle.Continuous;
                    jobProg.Value = 100;
                }
            }
            else
            {
                r.Ok = false;
                StringBuilder last = new StringBuilder();
                for (int i = Math.Max(0, errTail.Count - 12); i < errTail.Count; i++)
                {
                    if (last.Length > 0) last.Append(" | ");
                    last.Append(errTail[i]);
                }
                r.Details = last.ToString();
                r.Message = r.Stopped ? "用户已停止" : (errTail.Count > 0 ? TrimLine(errTail[errTail.Count - 1]) : ("ffmpeg 退出码 " + code));

                // 清理本次生成的残留输出（不删用户原有的文件）
                if (job != null && !job.OutputExistedBefore && File.Exists(job.Output))
                {
                    try { File.Delete(job.Output); AppendLog("[清理] 已删除未完成的输出文件"); }
                    catch { }
                }
            }

            try { p.Dispose(); } catch { }
            activeLog = null;
            if (!batchRunning) SetBusy(false);
            if (!batchRunning) SetStatus(r.Ok ? word + "完成 ✓" : (r.Stopped ? "已停止" : word + "失败"), r.Ok ? COk : CErr);
            jobProg = null;

            Action<JobResult> cb = onDone;
            onDone = null;
            if (cb != null) cb(r);
        }

        private string TrimLine(string s)
        {
            if (s == null) return "";
            string t = s.Trim();
            int idx = t.IndexOf("] ");
            if (t.StartsWith("[") && idx > 0 && idx < 20) t = t.Substring(idx + 2);
            if (t.Length > 200) t = t.Substring(0, 200) + "…";
            return t;
        }

        private void OnStop(object sender, EventArgs e)
        {
            if (!running || proc == null) return;
            DialogResult r = MessageBox.Show(this, "确定要停止当前任务吗？已经生成的部分会被删除。", "停止", MessageBoxButtons.YesNo, MessageBoxIcon.Question);
            if (r != DialogResult.Yes) return;

            stopRequested = true;
            AppendLog("[用户] 正在停止…");
            try { proc.Kill(); }
            catch (Exception ex) { AppendLog("[错误] 停止失败：" + ex.Message); }
        }

        private void OnClearLog(object sender, EventArgs e)
        {
            txtLog.Text = "";
        }

        private void OnOpenOutFolder(object sender, EventArgs e)
        {
            string p = "";
            if (currentJob != null && currentJob.Output.Length > 0) p = Path.GetDirectoryName(currentJob.Output);
            else if (txtOut.Text.Trim().Length > 0) p = Path.GetDirectoryName(txtOut.Text.Trim());
            else if (txtVideo.Text.Trim().Length > 0) p = Path.GetDirectoryName(txtVideo.Text.Trim());

            if (p != null && p.Length > 0 && Directory.Exists(p)) OpenFolder(p);
            else MessageBox.Show(this, "还没有可打开的输出目录。", "提示", MessageBoxButtons.OK, MessageBoxIcon.Information);
        }

        // 各功能页「打开输出目录」按钮共用：优先输出文件所在目录，其次源文件所在目录
        private void OnOpenOutByFunc(object sender, EventArgs e)
        {
            Button b = sender as Button;
            Func<string> getter = b == null ? null : b.Tag as Func<string>;
            string p = getter == null ? "" : getter();
            if (p != null && p.Length > 0 && Directory.Exists(p)) OpenFolder(p);
            else MessageBox.Show(this, "还没有可打开的输出目录。", "提示", MessageBoxButtons.OK, MessageBoxIcon.Information);
        }

        // 取文件所在目录；路径无效或目录不存在时返回空串
        private string DirOrEmpty(string path)
        {
            string p = (path == null ? "" : path).Trim();
            if (p.Length == 0) return "";
            try
            {
                string d = Path.GetDirectoryName(Path.GetFullPath(p));
                if (d != null && Directory.Exists(d)) return d;
            }
            catch { }
            return "";
        }

        // 依次尝试若干路径，返回第一个可用的所在目录（输出目录优先、源目录兜底）
        private string PickOpenFolder(params string[] paths)
        {
            if (paths != null)
            {
                foreach (string p in paths)
                {
                    string d = DirOrEmpty(p);
                    if (d.Length > 0) return d;
                }
            }
            return "";
        }

        private void OpenFolder(string dir)
        {
            if (dir == null || !Directory.Exists(dir)) return;
            try { Process.Start("explorer.exe", U.Q(dir)); }
            catch { }
        }
    }

    // ================= 入口 =================
    public class Program
    {
        [STAThread]
        public static void Main(string[] args)
        {
            try
            {
                if (args.Length >= 2 && args[0] == "--cli") { CliRunner.Run(args); return; }
                if (args.Length >= 2 && args[0] == "--selftest") { SelfTest(args[1]); return; }
                if (args.Length >= 2 && args[0] == "--snapshot") { Shot.Take(args[1]); return; }
                if (args.Length >= 2 && args[0] == "--screen") { Shot.ScreenShot(args[1]); return; }
                if (args.Length >= 4 && args[0] == "--picauto") { Shot.PicTest(args[1], args[2], args[3]); return; }
                if (args.Length >= 5 && args[0] == "--cvauto") { Shot.CvTest(args[1], args[2], args[3], int.Parse(args[4])); return; }
                if (args.Length >= 4 && args[0] == "--exauto") { Shot.ExTest(args[1], args[2], args[3]); return; }
                if (args.Length >= 3 && args[0] == "--cutauto")
                {
                    string cs = args.Length >= 4 ? args[3] : "";
                    string ce = args.Length >= 5 ? args[4] : "";
                    string co = args.Length >= 6 ? args[5] : "";
                    Shot.CutTest(args[1], args[2], cs, ce, co);
                    return;
                }
                if (args.Length >= 5 && args[0] == "--auto") { Shot.AutoTest(args[1], args[2], args[3], args[4]); return; }
                if (args.Length >= 4 && args[0] == "--joinauto")
                {
                    string[] js = new string[args.Length - 2];
                    for (int i = 0; i < js.Length; i++) js[i] = args[i + 2];
                    Shot.JoinTest(args[1], js);
                    return;
                }

                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
                Application.ThreadException += new ThreadExceptionEventHandler(delegate(object s, ThreadExceptionEventArgs e)
                {
                    string log = U.CrashLog(e.Exception);
                    MessageBox.Show("程序遇到错误：\n" + e.Exception.Message + "\n\n详细信息：" + log, "出错", MessageBoxButtons.OK, MessageBoxIcon.Error);
                });
                Ffmpeg.Detect();
                Application.Run(new MainForm());
            }
            catch (Exception ex)
            {
                string log = U.CrashLog(ex);
                try { MessageBox.Show("启动失败：\n" + ex.Message + "\n\n详细信息：" + log, "出错", MessageBoxButtons.OK, MessageBoxIcon.Error); }
                catch { }
            }
        }

        private static void SelfTest(string reportPath)
        {
            StringBuilder sb = new StringBuilder();
            try
            {
                bool ff = Ffmpeg.Detect();
                sb.AppendLine("ffmpeg=" + ff + " path=" + Ffmpeg.FfmpegPath);
                sb.AppendLine("ffprobe=" + Ffmpeg.ProbeReady + " path=" + Ffmpeg.FfprobePath);

                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                MainForm f = new MainForm();
                f.CreateControl();
                f.PerformLayout();
                sb.AppendLine("form=" + f.Text + " size=" + f.ClientSize.Width + "x" + f.ClientSize.Height);
                sb.AppendLine("controls=" + f.Controls.Count);
                f.Dispose();
                sb.AppendLine("RESULT=OK");
            }
            catch (Exception ex)
            {
                sb.AppendLine("RESULT=FAIL");
                sb.AppendLine(ex.ToString());
            }
            try { File.WriteAllText(reportPath, sb.ToString(), Encoding.Unicode); } catch { }
        }
    }

    // ================= 命令行模式（自检用） =================
    internal static class CliRunner
    {
        public static void Run(string[] args)
        {
            // --cli <video> <audio> <out> <mode> <container> <logfile>
            string logPath = args.Length >= 7 ? args[6] : "";
            StringBuilder log = new StringBuilder();
            int exitCode = 1;
            try
            {
                if (!Ffmpeg.Detect())
                {
                    log.AppendLine("NO_FFMPEG");
                    exitCode = 2;
                }
                else
                {
                    Job job = new Job();
                    job.Video = args[1];
                    job.Audio = args[2];
                    job.Output = args[3];
                    job.Mode = int.Parse(args[4]);
                    job.Container = args[5];

                    MediaInfo mi = Media.Probe(job.Video, true);
                    job.VideoDuration = mi.Duration;
                    log.AppendLine("videoDuration=" + mi.Duration + " codec=" + mi.Codec + " " + mi.Width + "x" + mi.Height);
                    MediaInfo ma = Media.Probe(job.Audio, false);
                    log.AppendLine("audioDuration=" + ma.Duration + " codec=" + ma.Codec);

                    StringBuilder sb = new StringBuilder();
                    sb.Append("-hide_banner -nostats -y ");
                    sb.Append("-i " + U.Q(job.Video) + " ");
                    sb.Append("-i " + U.Q(job.Audio) + " ");
                    sb.Append("-map 0:v:0 -map 1:a:0 ");
                    if (job.Mode == 0) sb.Append("-c:v copy -c:a copy ");
                    else if (job.Mode == 1) sb.Append("-c:v copy -c:a aac -b:a 192k ");
                    else sb.Append("-c:v libx264 -preset veryfast -crf 20 -pix_fmt yuv420p -c:a aac -b:a 192k ");
                    if (job.Container == "mp4") sb.Append("-movflags +faststart ");
                    sb.Append("-progress pipe:1 -loglevel info ");
                    sb.Append(U.Q(job.Output));

                    string cmd = sb.ToString();
                    log.AppendLine("CMD: " + cmd);

                    ProcessStartInfo psi = new ProcessStartInfo(Ffmpeg.FfmpegPath, cmd);
                    psi.UseShellExecute = false;
                    psi.CreateNoWindow = true;
                    psi.RedirectStandardOutput = true;
                    psi.RedirectStandardError = true;
                    psi.StandardOutputEncoding = Encoding.UTF8;
                    psi.StandardErrorEncoding = Encoding.UTF8;
                    Process p = new Process();
                    p.StartInfo = psi;

                    List<string> err = new List<string>();
                    p.Start();
                    StreamReader so = p.StandardOutput;
                    StreamReader se = p.StandardError;

                    string errLine;
                    int n = 0;
                    while ((errLine = se.ReadLine()) != null)
                    {
                        err.Add(errLine);
                        if (n++ < 60) log.AppendLine("ERR: " + errLine);
                    }
                    so.ReadToEnd();
                    p.WaitForExit(600000);

                    log.AppendLine("exit=" + p.ExitCode);
                    if (File.Exists(job.Output))
                    {
                        long len = new FileInfo(job.Output).Length;
                        log.AppendLine("outputSize=" + len);
                        MediaInfo mo = Media.Probe(job.Output, true);
                        log.AppendLine("outputDuration=" + mo.Duration + " codec=" + mo.Codec + " " + mo.Width + "x" + mo.Height);
                        exitCode = (p.ExitCode == 0 && len > 0) ? 0 : 1;
                    }
                    else
                    {
                        log.AppendLine("outputMissing");
                        exitCode = 1;
                    }
                    try { p.Dispose(); } catch { }
                }
            }
            catch (Exception ex)
            {
                log.AppendLine("EXCEPTION: " + ex.ToString());
                exitCode = 3;
            }
            try { if (logPath.Length > 0) File.WriteAllText(logPath, log.ToString(), Encoding.Unicode); }
            catch { }
            Environment.Exit(exitCode);
        }
    }
}
