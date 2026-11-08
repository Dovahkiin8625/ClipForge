using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Threading;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Text;
using System.Windows.Forms;

namespace ClipForge
{
    internal static class Shot
    {
        public static void Take(string dir)
        {
            try
            {
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Ffmpeg.Detect();

                MainForm f = new MainForm();
                f.StartPosition = FormStartPosition.Manual;
                f.Location = new Point(-6000, -6000);
                f.Show();
                Application.DoEvents();
                System.Threading.Thread.Sleep(250);
                Application.DoEvents();

                Save(f, Path.Combine(dir, "page1.png"));
                WriteLayout(f, Path.Combine(dir, "layout.txt"));

                f.JumpMergeBatch();
                System.Threading.Thread.Sleep(250);
                Application.DoEvents();
                Save(f, Path.Combine(dir, "page2.png"));

                for (int i = 1; i < f.TabCount; i++)
                {
                    f.JumpToTab(i);
                    System.Threading.Thread.Sleep(200);
                    Application.DoEvents();
                    Save(f, Path.Combine(dir, "page" + (i + 2) + ".png"));
                }

                f.Close();
            }
            catch (Exception ex)
            {
                U.CrashLog(ex);
            }
        }

        public static void AutoTest(string reportPath, string v, string a, string o)
        {
            StringBuilder sb = new StringBuilder();
            try
            {
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Ffmpeg.Detect();

                MainForm f = new MainForm();
                f.StartPosition = FormStartPosition.Manual;
                f.Location = new Point(-6000, -6000);
                f.Show();
                Application.DoEvents();

                f.UiStart(v, a, o);
                DateTime t0 = DateTime.Now;
                while (f.UiRunning && (DateTime.Now - t0).TotalSeconds < 180)
                {
                    Application.DoEvents();
                    System.Threading.Thread.Sleep(60);
                }
                Application.DoEvents();
                System.Threading.Thread.Sleep(200);
                Application.DoEvents();

                sb.AppendLine("status=" + f.UiStatus);
                sb.AppendLine("stillRunning=" + f.UiRunning);
                sb.AppendLine("outputExists=" + File.Exists(o));
                if (File.Exists(o)) sb.AppendLine("outputSize=" + new FileInfo(o).Length);
                sb.AppendLine("elapsedSec=" + Math.Round((DateTime.Now - t0).TotalSeconds, 1));
                sb.AppendLine("---LOG---");
                sb.AppendLine(f.UiLog);
                f.Close();
            }
            catch (Exception ex)
            {
                sb.AppendLine("EXCEPTION=" + ex.ToString());
            }
            try { File.WriteAllText(reportPath, sb.ToString(), Encoding.UTF8); }
            catch { }
        }

        public static void ExTest(string reportPath, string src, string o)
        {
            StringBuilder sb = new StringBuilder();
            try
            {
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Ffmpeg.Detect();

                MainForm f = new MainForm();
                f.StartPosition = FormStartPosition.Manual;
                f.Location = new Point(-6000, -6000);
                f.Show();
                Application.DoEvents();

                f.UiExtract(src, o);
                DateTime t0 = DateTime.Now;
                while (f.UiRunning && (DateTime.Now - t0).TotalSeconds < 180)
                {
                    Application.DoEvents();
                    System.Threading.Thread.Sleep(60);
                }
                Application.DoEvents();
                System.Threading.Thread.Sleep(200);
                Application.DoEvents();

                sb.AppendLine("status=" + f.UiStatus);
                sb.AppendLine("stillRunning=" + f.UiRunning);
                sb.AppendLine("outputExists=" + File.Exists(o));
                if (File.Exists(o)) sb.AppendLine("outputSize=" + new FileInfo(o).Length);
                sb.AppendLine("elapsedSec=" + Math.Round((DateTime.Now - t0).TotalSeconds, 1));
                sb.AppendLine("---LOG---");
                sb.AppendLine(f.UiLog);
                f.Close();
            }
            catch (Exception ex)
            {
                sb.AppendLine("EXCEPTION=" + ex.ToString());
            }
            try { File.WriteAllText(reportPath, sb.ToString(), Encoding.UTF8); }
            catch { }
        }

        public static void CutTest(string reportPath, string src, string start, string end, string outputPath)
        {
            StringBuilder sb = new StringBuilder();
            try
            {
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Ffmpeg.Detect();

                MainForm f = new MainForm();
                f.StartPosition = FormStartPosition.Manual;
                f.Location = new Point(-6000, -6000);
                f.Show();
                Application.DoEvents();

                f.JumpToTab(2);
                f.UiCut(src);
                DateTime t0 = DateTime.Now;
                while (f.CutThumbCount == 0 && (DateTime.Now - t0).TotalSeconds < 60)
                {
                    Application.DoEvents();
                    System.Threading.Thread.Sleep(100);
                }
                System.Threading.Thread.Sleep(1500);   // 等首帧预览
                Application.DoEvents();
                System.Threading.Thread.Sleep(200);
                Application.DoEvents();

                sb.AppendLine("ffmpeg=" + Ffmpeg.Ready);
                sb.AppendLine("thumbs=" + f.CutThumbCount);
                sb.AppendLine("preview=" + f.CutHasPreview);
                sb.AppendLine("start=" + f.CutStartText + " end=" + f.CutEndText);

                if (start.Length > 0)
                {
                    f.UiCutRun(src, start, end, outputPath);
                    DateTime t1 = DateTime.Now;
                    while (f.UiRunning && (DateTime.Now - t1).TotalSeconds < 180)
                    {
                        Application.DoEvents();
                        System.Threading.Thread.Sleep(60);
                    }
                    Application.DoEvents();
                    System.Threading.Thread.Sleep(200);
                    Application.DoEvents();
                    sb.AppendLine("status=" + f.UiStatus);
                    sb.AppendLine("stillRunning=" + f.UiRunning);
                    sb.AppendLine("outputExists=" + File.Exists(outputPath));
                    if (File.Exists(outputPath)) sb.AppendLine("outputSize=" + new FileInfo(outputPath).Length);
                    sb.AppendLine("---LOG---");
                    sb.AppendLine(f.UiLog);
                }

                try { Save(f, Path.ChangeExtension(reportPath, ".png")); sb.AppendLine("shot=saved"); }
                catch (Exception ex2) { sb.AppendLine("shot=" + ex2.Message); }
                f.Close();
            }
            catch (Exception ex)
            {
                sb.AppendLine("EXCEPTION=" + ex.ToString());
            }
            try { File.WriteAllText(reportPath, sb.ToString(), Encoding.UTF8); }
            catch { }
        }

        // 自测用：视频拼接（先直接拼接，再统一转码拼接，各跑一遍）
        public static void JoinTest(string reportPath, params string[] clips)
        {
            StringBuilder sb = new StringBuilder();
            try
            {
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Ffmpeg.Detect();
                sb.AppendLine("ffmpeg=" + Ffmpeg.Ready);

                string dir = Path.GetDirectoryName(reportPath);
                if (string.IsNullOrEmpty(dir)) dir = Path.GetTempPath();
                string outCopy = Path.Combine(dir, "join_copy.mp4");
                string outEnc = Path.Combine(dir, "join_enc.mp4");

                MainForm f = new MainForm();
                f.StartPosition = FormStartPosition.Manual;
                f.Location = new Point(-6000, -6000);
                f.Show();
                Application.DoEvents();

                f.JumpToTab(3);
                try { File.Delete(outCopy); } catch { }
                sb.AppendLine("--- 直接拼接 ---");
                f.UiJoin(clips, outCopy, false);
                DateTime t0 = DateTime.Now;
                while (f.UiRunning && (DateTime.Now - t0).TotalSeconds < 180)
                {
                    Application.DoEvents();
                    System.Threading.Thread.Sleep(60);
                }
                Application.DoEvents();
                sb.AppendLine("copyStatus=" + f.UiJoinStatus);
                sb.AppendLine("copyExists=" + File.Exists(outCopy));
                if (File.Exists(outCopy))
                {
                    sb.AppendLine("copySize=" + new FileInfo(outCopy).Length);
                    sb.AppendLine("copyDur=" + FfmpegProbeDur(outCopy));
                }
                sb.AppendLine("--- 直接拼接日志 ---");
                sb.AppendLine(f.UiLog);

                try { File.Delete(outEnc); } catch { }
                sb.AppendLine("--- 统一转码拼接 ---");
                f.UiJoin(clips, outEnc, true);
                DateTime t1 = DateTime.Now;
                while (f.UiRunning && (DateTime.Now - t1).TotalSeconds < 300)
                {
                    Application.DoEvents();
                    System.Threading.Thread.Sleep(60);
                }
                Application.DoEvents();
                sb.AppendLine("encStatus=" + f.UiJoinStatus);
                sb.AppendLine("encExists=" + File.Exists(outEnc));
                if (File.Exists(outEnc))
                {
                    sb.AppendLine("encSize=" + new FileInfo(outEnc).Length);
                    sb.AppendLine("encDur=" + FfmpegProbeDur(outEnc));
                }
                sb.AppendLine("--- 统一转码拼接新增日志 ---");
                sb.AppendLine(f.UiJoinLog);

                try { File.Delete(outCopy); File.Delete(outEnc); } catch { }
                f.Close();
            }
            catch (Exception ex)
            {
                sb.AppendLine("EXCEPTION=" + ex.ToString());
            }
            try { File.WriteAllText(reportPath, sb.ToString(), Encoding.UTF8); }
            catch { }
        }

        private static double FfmpegProbeDur(string file)
        {
            try
            {
                if (!Ffmpeg.ProbeReady) return -1;
                string args = "-v error -show_entries format=duration -of default=nw=1:nk=1 " + U.Q(file);
                ProcessStartInfo psi = new ProcessStartInfo(Ffmpeg.FfprobePath, args);
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                psi.RedirectStandardOutput = true;
                psi.StandardOutputEncoding = Encoding.UTF8;
                using (Process p = Process.Start(psi))
                {
                    string outp = p.StandardOutput.ReadToEnd().Trim();
                    p.WaitForExit(15000);
                    double d;
                    if (double.TryParse(outp, out d)) return d;
                }
            }
            catch { }
            return -1;
        }

        // 自测用：画面调整（预览抓帧 + 完整处理一遍）
        public static void PicTest(string reportPath, string src, string outputPath)
        {
            StringBuilder sb = new StringBuilder();
            try
            {
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Ffmpeg.Detect();
                sb.AppendLine("ffmpeg=" + Ffmpeg.Ready);

                MainForm f = new MainForm();
                f.StartPosition = FormStartPosition.Manual;
                f.Location = new Point(-6000, -6000);
                f.Show();
                Application.DoEvents();

                f.JumpToTab(4);
                f.UiPic(src);
                DateTime t0 = DateTime.Now;
                while (!f.PicHasFrame && (DateTime.Now - t0).TotalSeconds < 60)
                {
                    Application.DoEvents();
                    System.Threading.Thread.Sleep(100);
                }
                Application.DoEvents();
                System.Threading.Thread.Sleep(500);
                Application.DoEvents();

                sb.AppendLine("frame=" + f.PicHasFrame);
                sb.AppendLine("adjPreview=" + f.PicHasAdj);

                try { Save(f, Path.ChangeExtension(reportPath, ".png")); sb.AppendLine("shot=saved"); }
                catch (Exception ex2) { sb.AppendLine("shot=" + ex2.Message); }

                try { File.Delete(outputPath); } catch { }
                f.UiPicRun(src, outputPath);
                DateTime t1 = DateTime.Now;
                while (f.UiRunning && (DateTime.Now - t1).TotalSeconds < 300)
                {
                    Application.DoEvents();
                    System.Threading.Thread.Sleep(60);
                }
                Application.DoEvents();
                System.Threading.Thread.Sleep(200);
                Application.DoEvents();

                sb.AppendLine("status=" + f.UiPicStatus);
                sb.AppendLine("stillRunning=" + f.UiRunning);
                sb.AppendLine("outputExists=" + File.Exists(outputPath));
                if (File.Exists(outputPath))
                {
                    sb.AppendLine("outputSize=" + new FileInfo(outputPath).Length);
                    sb.AppendLine("outputInfo=" + FfmpegProbeDims(outputPath));
                }
                sb.AppendLine("---LOG---");
                sb.AppendLine(f.UiPicLog);

                // 第二遍：带调整（旋转90° + 四边裁 10px + 亮度 +0.2 / 对比度 +0.2 / 饱和度 -0.3）
                try { File.Delete(outputPath); } catch { }
                f.UiPicRun2(src, outputPath, 0, false, false, -1,
                    10, 10, 10, 10, 20, 20, -30);
                DateTime t2 = DateTime.Now;
                while (f.UiRunning && (DateTime.Now - t2).TotalSeconds < 300)
                {
                    Application.DoEvents();
                    System.Threading.Thread.Sleep(60);
                }
                Application.DoEvents();
                sb.AppendLine("--- 带调整（旋转90°+裁剪+调色） ---");
                sb.AppendLine("status=" + f.UiPicStatus);
                sb.AppendLine("outputExists=" + File.Exists(outputPath));
                if (File.Exists(outputPath))
                {
                    sb.AppendLine("outputSize=" + new FileInfo(outputPath).Length);
                    sb.AppendLine("outputInfo=" + FfmpegProbeDims(outputPath));
                }
                try { Save(f, reportPath.Replace(".txt", ".adj.png")); sb.AppendLine("shot2=saved"); }
                catch (Exception ex3) { sb.AppendLine("shot2=" + ex3.Message); }
                sb.AppendLine("---LOG---");
                sb.AppendLine(f.UiPicLog);

                // 第三遍：旋转180° + 缩放到 640×360 + 水平镜像
                try { File.Delete(outputPath); } catch { }
                f.UiPicRun2(src, outputPath, 1, true, false, 3,
                    0, 0, 0, 0, 0, 0, 0);
                DateTime t3 = DateTime.Now;
                while (f.UiRunning && (DateTime.Now - t3).TotalSeconds < 300)
                {
                    Application.DoEvents();
                    System.Threading.Thread.Sleep(60);
                }
                Application.DoEvents();
                sb.AppendLine("--- 带调整（180°+640×360+镜像） ---");
                sb.AppendLine("status=" + f.UiPicStatus);
                sb.AppendLine("outputExists=" + File.Exists(outputPath));
                if (File.Exists(outputPath))
                {
                    sb.AppendLine("outputSize=" + new FileInfo(outputPath).Length);
                    sb.AppendLine("outputInfo=" + FfmpegProbeDims(outputPath));
                }
                f.Close();
            }
            catch (Exception ex)
            {
                sb.AppendLine("EXCEPTION=" + ex.ToString());
            }
            try { File.WriteAllText(reportPath, sb.ToString(), Encoding.UTF8); }
            catch { }
        }

        // 自测用：格式转换（formatIdx 对应 cmbCvFormat 的选项序号：0 MP4 … 9 GIF）
        public static void CvTest(string reportPath, string src, string outputPath, int formatIdx)
        {
            StringBuilder sb = new StringBuilder();
            try
            {
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Ffmpeg.Detect();
                sb.AppendLine("ffmpeg=" + Ffmpeg.Ready);

                MainForm f = new MainForm();
                f.StartPosition = FormStartPosition.Manual;
                f.Location = new Point(-6000, -6000);
                f.Show();
                Application.DoEvents();

                try { File.Delete(outputPath); } catch { }
                f.UiConvert(src, outputPath, formatIdx);
                DateTime t0 = DateTime.Now;
                while (f.UiRunning && (DateTime.Now - t0).TotalSeconds < 300)
                {
                    Application.DoEvents();
                    System.Threading.Thread.Sleep(60);
                }
                Application.DoEvents();
                System.Threading.Thread.Sleep(200);
                Application.DoEvents();

                sb.AppendLine("format=" + formatIdx);
                sb.AppendLine("status=" + f.UiConvertStatus);
                sb.AppendLine("stillRunning=" + f.UiRunning);
                sb.AppendLine("outputExists=" + File.Exists(outputPath));
                if (File.Exists(outputPath))
                {
                    sb.AppendLine("outputSize=" + new FileInfo(outputPath).Length);
                    if (formatIdx != 9) sb.AppendLine("outputInfo=" + FfmpegProbeDims(outputPath));
                }
                sb.AppendLine("elapsedSec=" + Math.Round((DateTime.Now - t0).TotalSeconds, 1));
                sb.AppendLine("---LOG---");
                sb.AppendLine(f.UiConvertLog);
                f.Close();
            }
            catch (Exception ex)
            {
                sb.AppendLine("EXCEPTION=" + ex.ToString());
            }
            try { File.WriteAllText(reportPath, sb.ToString(), Encoding.UTF8); }
            catch { }
        }

        private static string FfmpegProbeDims(string file)
        {
            try
            {
                if (!Ffmpeg.ProbeReady) return "?";
                string args = "-v error -select_streams v:0 -show_entries stream=codec_name,width,height -show_entries format=duration -of default=nw=1 " + U.Q(file);
                ProcessStartInfo psi = new ProcessStartInfo(Ffmpeg.FfprobePath, args);
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                psi.RedirectStandardOutput = true;
                psi.StandardOutputEncoding = Encoding.UTF8;
                using (Process p = Process.Start(psi))
                {
                    string outp = p.StandardOutput.ReadToEnd().Trim().Replace("\n", " ");
                    p.WaitForExit(15000);
                    return outp;
                }
            }
            catch { }
            return "?";
        }

        public static void ScreenShot(string dir)
        {            try
            {
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Ffmpeg.Detect();

                MainForm f = new MainForm();
                Rectangle wa = Screen.PrimaryScreen.WorkingArea;
                f.StartPosition = FormStartPosition.Manual;
                f.Location = new Point(wa.Width / 2 - f.Width / 2, wa.Height / 2 - f.Height / 2);
                f.Show();
                f.Activate();
                Application.DoEvents();
                System.Threading.Thread.Sleep(350);
                Application.DoEvents();

                Grab(f, Path.Combine(dir, "screen1.png"));
                f.JumpMergeBatch();
                System.Threading.Thread.Sleep(250);
                Application.DoEvents();
                Grab(f, Path.Combine(dir, "screen2.png"));
                for (int i = 1; i < f.TabCount; i++)
                {
                    f.JumpToTab(i);
                    System.Threading.Thread.Sleep(250);
                    Application.DoEvents();
                    Grab(f, Path.Combine(dir, "screen" + (i + 2) + ".png"));
                }
                f.Close();
            }
            catch (Exception ex)
            {
                U.CrashLog(ex);
            }
        }

        private static void Grab(Form f, string path)
        {
            Rectangle r = f.Bounds;
            EnsureDir(path);
            using (Bitmap bmp = new Bitmap(r.Width, r.Height))
            {
                using (Graphics g = Graphics.FromImage(bmp))
                {
                    g.CopyFromScreen(r.Left, r.Top, 0, 0, new Size(r.Width, r.Height));
                }
                bmp.Save(path, ImageFormat.Png);
            }
        }

        private static void Save(Form f, string path)
        {
            EnsureDir(path);
            Bitmap bmp = new Bitmap(f.ClientSize.Width, f.ClientSize.Height);
            f.DrawToBitmap(bmp, new Rectangle(0, 0, f.ClientSize.Width, f.ClientSize.Height));
            bmp.Save(path, ImageFormat.Png);
            bmp.Dispose();
        }

        // GDI+ 保存目标目录不存在时会抛「generic error」，这里先建目录
        private static void EnsureDir(string path)
        {
            try
            {
                string d = Path.GetDirectoryName(path);
                if (!string.IsNullOrEmpty(d) && !Directory.Exists(d)) Directory.CreateDirectory(d);
            }
            catch { }
        }

        private static void WriteLayout(Form f, string path)
        {
            StringBuilder sb = new StringBuilder();
            sb.AppendLine("FORM client=" + f.ClientSize.Width + "x" + f.ClientSize.Height);
            sb.AppendLine("AutoScaleMode=" + f.AutoScaleMode + " Font=" + f.Font.Name + " " + f.Font.SizeInPoints);
            foreach (Control c in f.Controls) Dump(c, sb, 1);
            File.WriteAllText(path, sb.ToString(), Encoding.UTF8);
        }

        private static void Dump(Control c, StringBuilder sb, int depth)
        {
            string pad = new string(' ', depth * 2);
            string txt = c.Text.Replace("\r", "").Replace("\n", "");
            if (txt.Length > 24) txt = txt.Substring(0, 24);
            sb.AppendLine(pad + c.GetType().Name + " [" + txt + "] x=" + c.Left + " y=" + c.Top
                + " w=" + c.Width + " h=" + c.Height + " anchor=" + c.Anchor.ToString() + " visible=" + c.Visible);
            foreach (Control k in c.Controls) Dump(k, sb, depth + 1);
        }
    }
}
