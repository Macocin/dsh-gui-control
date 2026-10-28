# dsh-gui-control helper: persistent Windows screen-capture + input simulator.
# Speaks one JSON object per line on stdin/stdout. ASCII-only source on purpose:
# Windows PowerShell 5.1 reads .ps1 as ANSI when there is no BOM.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Runtime.WindowsRuntime

$src = @'
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

public static class DshWin
{
    // ---------------- native ----------------
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr v);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern int GetSystemMetrics(int i);
    [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
    [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool f);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr lp);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
    [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int idx);
    [DllImport("user32.dll")] static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, MonProc cb, IntPtr lp);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool GetMonitorInfoW(IntPtr mon, ref MONITORINFOEX mi);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int val, int size);
    [DllImport("shcore.dll")] static extern int GetDpiForMonitor(IntPtr hmon, int type, out uint dx, out uint dy);
    [DllImport("user32.dll")] static extern uint SendInput(uint n, INPUT[] inputs, int size);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern short VkKeyScanW(char c);
    [DllImport("user32.dll")] static extern uint MapVirtualKey(uint code, uint type);
    [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
    [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr h);
    [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr h, IntPtr dc);
    [DllImport("gdi32.dll")] static extern bool BitBlt(IntPtr dd, int dx, int dy, int w, int h, IntPtr sd, int sx, int sy, uint rop);
    [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint msg, IntPtr wp, IntPtr lp);

    [StructLayout(LayoutKind.Sequential)] struct POINT { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct MONITORINFOEX
    {
        public int cbSize;
        public RECT rcMonitor;
        public RECT rcWork;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string szDevice;
    }

    delegate bool EnumProc(IntPtr h, IntPtr lp);
    delegate bool MonProc(IntPtr hmon, IntPtr hdc, IntPtr rect, IntPtr lp);

    [StructLayout(LayoutKind.Sequential)]
    struct MOUSEINPUT { public int dx, dy; public uint mouseData, flags, time; public IntPtr extra; }
    [StructLayout(LayoutKind.Sequential)]
    struct KEYBDINPUT { public ushort vk, scan; public uint flags, time; public IntPtr extra; }
    [StructLayout(LayoutKind.Explicit)]
    struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
    [StructLayout(LayoutKind.Sequential)]
    struct INPUT { public int type; public INPUTUNION u; }

    const int INPUT_MOUSE = 0, INPUT_KEY = 1;
    const uint MOVE = 0x0001, LEFTDOWN = 0x0002, LEFTUP = 0x0004, RIGHTDOWN = 0x0008, RIGHTUP = 0x0010;
    const uint MIDDLEDOWN = 0x0020, MIDDLEUP = 0x0040, WHEEL = 0x0800, HWHEEL = 0x1000;
    const uint ABSOLUTE = 0x8000, VIRTUALDESK = 0x4000;
    const uint KEYUP = 0x0002, UNICODE = 0x0004, SCANCODE = 0x0008;

    static readonly Random Rnd = new Random();

    static DshWin()
    {
        try { SetProcessDpiAwarenessContext(new IntPtr(-4)); }
        catch { try { SetProcessDPIAware(); } catch { } }
    }

    static int R(int lo, int hi) { lock (Rnd) { return Rnd.Next(lo, hi); } }
    static double D() { lock (Rnd) { return Rnd.NextDouble(); } }

    // ---------------- metrics ----------------
    static int VX { get { return GetSystemMetrics(76); } }
    static int VY { get { return GetSystemMetrics(77); } }
    static int VW { get { return GetSystemMetrics(78); } }
    static int VH { get { return GetSystemMetrics(79); } }

    // ---------------- capture ----------------
    public static Hashtable Capture(int left, int top, int width, int height, string format, int quality,
        int maxWidth, int maxHeight, bool grayscale, bool drawCursor, bool grid, string path, int maxBytes)
    {
        DshHalt.Guard();
        if (width <= 0 || height <= 0) { left = VX; top = VY; width = VW; height = VH; }
        int srcW = width, srcH = height;
        if (width < 8) width = 8;
        if (height < 8) height = 8;

        Bitmap full;
        try
        {
            full = new Bitmap(width, height, PixelFormat.Format32bppArgb);
            using (Graphics g = Graphics.FromImage(full))
            {
                IntPtr dd = g.GetHdc();
                IntPtr sd = GetDC(IntPtr.Zero);
                try
                {
                    if (!BitBlt(dd, 0, 0, width, height, sd, left, top, 0x00CC0020u | 0x40000000u))
                        throw new InvalidOperationException("BitBlt failed, win32err=" + Marshal.GetLastWin32Error());
                }
                finally
                {
                    ReleaseDC(IntPtr.Zero, sd);
                    g.ReleaseHdc(dd);
                }
            }
        }
        catch (Exception ex)
        {
            throw new InvalidOperationException("screen capture failed: " + ex.Message);
        }

        int outW = width, outH = height;
        if (maxWidth > 0 || maxHeight > 0)
        {
            double sx = maxWidth > 0 ? (double)maxWidth / width : 1.0;
            double sy = maxHeight > 0 ? (double)maxHeight / height : 1.0;
            double s = Math.Min(1.0, Math.Min(sx, sy));
            outW = Math.Max(8, (int)Math.Round(width * s));
            outH = Math.Max(8, (int)Math.Round(height * s));
        }

        Bitmap img = full;
        if (outW != width || outH != height)
        {
            img = new Bitmap(outW, outH, PixelFormat.Format32bppArgb);
            using (Graphics g = Graphics.FromImage(img))
            {
                g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                g.PixelOffsetMode = PixelOffsetMode.HighQuality;
                g.SmoothingMode = SmoothingMode.HighQuality;
                g.DrawImage(full, new Rectangle(0, 0, outW, outH));
            }
            full.Dispose();
        }

        double sxs = (double)outW / width, sys = (double)outH / height;

        if (grayscale)
        {
            for (int y = 0; y < outH; y++)
                for (int x = 0; x < outW; x++)
                {
                    Color c = img.GetPixel(x, y);
                    int v = (int)(c.R * 0.299 + c.G * 0.587 + c.B * 0.114);
                    img.SetPixel(x, y, Color.FromArgb(255, v, v, v));
                }
        }

        if (grid || drawCursor)
        {
            using (Graphics g = Graphics.FromImage(img))
            {
                g.SmoothingMode = SmoothingMode.AntiAlias;
                if (grid)
                {
                    using (Pen p = new Pen(Color.FromArgb(70, 0, 160, 255), 1))
                    using (SolidBrush b = new SolidBrush(Color.FromArgb(210, 0, 90, 200)))
                    using (Font f = new Font("Consolas", 11f, FontStyle.Bold))
                    {
                        int gx0 = (int)Math.Ceiling(left / 100.0) * 100;
                        for (int gx = gx0; gx < left + width; gx += 100)
                        {
                            int ix = (int)Math.Round((gx - left) * sxs);
                            g.DrawLine(p, ix, 0, ix, outH);
                            if (gx % 200 == 0 && ix > 2 && ix < outW - 40) g.DrawString(gx.ToString(), f, b, ix + 2, 2);
                        }
                        int gy0 = (int)Math.Ceiling(top / 100.0) * 100;
                        for (int gy = gy0; gy < top + height; gy += 100)
                        {
                            int iy = (int)Math.Round((gy - top) * sys);
                            g.DrawLine(p, 0, iy, outW, iy);
                            if (gy % 200 == 0 && iy > 2 && iy < outH - 18) g.DrawString(gy.ToString(), f, b, 2, iy + 1);
                        }
                    }
                }
                if (drawCursor)
                {
                    POINT pt;
                    if (GetCursorPos(out pt) && pt.X >= left && pt.Y >= top && pt.X < left + width && pt.Y < top + height)
                    {
                        int cx = (int)Math.Round((pt.X - left) * sxs), cy = (int)Math.Round((pt.Y - top) * sys);
                        using (Pen ring = new Pen(Color.FromArgb(230, 0, 255, 120), 2))
                        using (Pen mark = new Pen(Color.FromArgb(230, 0, 200, 90), 2))
                        {
                            int rr = Math.Max(9, (int)(outW * 0.012));
                            g.DrawEllipse(ring, cx - rr, cy - rr, rr * 2, rr * 2);
                            g.DrawLine(mark, cx - rr - 6, cy, cx - rr + 2, cy);
                            g.DrawLine(mark, cx + rr - 2, cy, cx + rr + 6, cy);
                            g.DrawLine(mark, cx, cy - rr - 6, cx, cy - rr + 2);
                            g.DrawLine(mark, cx, cy + rr - 2, cx, cy + rr + 6);
                        }
                    }
                }
            }
        }

        string mediaType = format == "png" ? "image/png" : "image/jpeg";
        int q = Math.Max(10, Math.Min(100, quality));
        byte[] bytes = Encode(img, mediaType, q);
        int tries = 0;
        while (maxBytes > 0 && bytes.Length > maxBytes && mediaType == "image/jpeg" && tries < 4)
        {
            q = Math.Max(22, q - 14);
            bytes = Encode(img, mediaType, q);
            tries++;
            if (q <= 22) break;
        }
        if (maxBytes > 0 && bytes.Length > maxBytes && mediaType == "image/jpeg")
        {
            outH = Math.Max(8, (int)(outH * 0.72)); outW = Math.Max(8, (int)(outW * 0.72));
            using (Bitmap small = new Bitmap(outW, outH, PixelFormat.Format32bppArgb))
            {
                using (Graphics g = Graphics.FromImage(small))
                {
                    g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                    g.DrawImage(img, new Rectangle(0, 0, outW, outH));
                }
                bytes = Encode(small, mediaType, q);
            }
            sxs = (double)outW / width; sys = (double)outH / height;
        }

        string dir = Path.GetDirectoryName(path);
        if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
        File.WriteAllBytes(path, bytes);

        POINT cur; GetCursorPos(out cur);
        Hashtable h = new Hashtable();
        h["ok"] = true;
        h["path"] = path;
        h["mediaType"] = mediaType;
        h["bytes"] = bytes.Length;
        h["width"] = outW; h["height"] = outH;
        h["srcWidth"] = width; h["srcHeight"] = height;
        h["region"] = new Hashtable { { "left", left }, { "top", top }, { "width", width }, { "height", height } };
        h["scaleX"] = sxs; h["scaleY"] = sys;
        h["quality"] = q;
        h["cursor"] = new Hashtable { { "x", cur.X }, { "y", cur.Y } };
        img.Dispose();
        return h;
    }

    static byte[] Encode(Bitmap img, string mediaType, int quality)
    {
        using (MemoryStream ms = new MemoryStream())
        {
            if (mediaType == "image/png")
            {
                img.Save(ms, ImageFormat.Png);
            }
            else
            {
                ImageCodecInfo codec = null;
                foreach (ImageCodecInfo c in ImageCodecInfo.GetImageEncoders())
                    if (c.FormatID == ImageFormat.Jpeg.Guid) { codec = c; break; }
                EncoderParameters ps = new EncoderParameters(1);
                ps.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, (long)quality);
                img.Save(ms, codec, ps);
            }
            return ms.ToArray();
        }
    }

    // ---------------- info ----------------
    public static Hashtable Info(bool incWindows, int limit)
    {
        Hashtable h = new Hashtable();
        h["ok"] = true;
        h["virtualScreen"] = new Hashtable { { "left", VX }, { "top", VY }, { "width", VW }, { "height", VH } };
        List<object> mons = new List<object>();
        int idx = 0;
        EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, delegate(IntPtr hmon, IntPtr hdc, IntPtr rect, IntPtr lp)
        {
            MONITORINFOEX mi = new MONITORINFOEX();
            mi.cbSize = Marshal.SizeOf(typeof(MONITORINFOEX));
            if (!GetMonitorInfoW(hmon, ref mi)) return true;
            uint dx = 0, dy = 0; double scale = 0;
            try
            {
                if (GetDpiForMonitor(hmon, 0, out dx, out dy) == 0 && dx > 0) scale = Math.Round(dx / 96.0, 2);
            }
            catch { }
            Hashtable m = new Hashtable();
            m["index"] = idx++;
            m["primary"] = (mi.dwFlags & 1) != 0;
            m["device"] = mi.szDevice;
            m["bounds"] = new Hashtable { { "left", mi.rcMonitor.Left }, { "top", mi.rcMonitor.Top }, { "width", mi.rcMonitor.Right - mi.rcMonitor.Left }, { "height", mi.rcMonitor.Bottom - mi.rcMonitor.Top } };
            m["workArea"] = new Hashtable { { "left", mi.rcWork.Left }, { "top", mi.rcWork.Top }, { "width", mi.rcWork.Right - mi.rcWork.Left }, { "height", mi.rcWork.Bottom - mi.rcWork.Top } };
            if (scale > 0) m["dpiScale"] = scale;
            mons.Add(m);
            return true;
        }, IntPtr.Zero);
        h["monitors"] = mons;
        POINT c; GetCursorPos(out c);
        h["cursor"] = new Hashtable { { "x", c.X }, { "y", c.Y } };
        IntPtr fg = GetForegroundWindow();
        h["foreground"] = WinInfo(fg, true);
        if (incWindows)
        {
            List<object> list = new List<object>();
            EnumWindows(delegate(IntPtr wh, IntPtr lp)
            {
                if (list.Count >= Math.Max(1, limit)) return false;
                if (!IsWindowVisible(wh)) return true;
                if (wh == fg) return true;
                int cloaked;
                if (DwmGetWindowAttribute(wh, 14, out cloaked, sizeof(int)) == 0 && cloaked != 0) return true;
                StringBuilder t = new StringBuilder(512);
                GetWindowTextW(wh, t, t.Capacity);
                if (t.Length == 0) return true;
                int ex = GetWindowLong(wh, -20);
                if ((ex & 0x00000080) != 0) return true;
                RECT r; GetWindowRect(wh, out r);
                if (r.Right - r.Left < 40 || r.Bottom - r.Top < 30) return true;
                list.Add(WinInfo(wh, false));
                return true;
            }, IntPtr.Zero);
            h["windows"] = list;
        }
        return h;
    }

    static Hashtable WinInfo(IntPtr h, bool detail)
    {
        Hashtable w = new Hashtable();
        if (h == IntPtr.Zero) { w["hwnd"] = 0; w["title"] = ""; return w; }
        StringBuilder t = new StringBuilder(512);
        GetWindowTextW(h, t, t.Capacity);
        StringBuilder cls = new StringBuilder(256);
        GetClassNameW(h, cls, cls.Capacity);
        uint pid; GetWindowThreadProcessId(h, out pid);
        RECT r; GetWindowRect(h, out r);
        w["hwnd"] = h.ToInt64();
        w["title"] = t.ToString();
        w["class"] = cls.ToString();
        w["pid"] = (int)pid;
        try { w["process"] = Process.GetProcessById((int)pid).ProcessName; } catch { }
        w["rect"] = new Hashtable { { "left", r.Left }, { "top", r.Top }, { "width", r.Right - r.Left }, { "height", r.Bottom - r.Top } };
        w["minimized"] = IsIconic(h);
        if (detail) w["foreground"] = true;
        return w;
    }

    // ---------------- windows ----------------
    public static Hashtable Window(string action, string title, long hwnd, int x, int y, int w, int h)
    {
        if (action != "info") DshHalt.Guard();
        IntPtr target = FindWindow(title, hwnd);
        if (target == IntPtr.Zero) throw new InvalidOperationException("window not found: " + (title ?? hwnd.ToString()));
        Hashtable r = new Hashtable();
        r["ok"] = true;
        r["action"] = action;
        if (action == "focus")
        {
            if (IsIconic(target)) ShowWindow(target, 9);
            ForceForeground(target);
            Thread.Sleep(R(120, 240));
        }
        else if (action == "minimize") ShowWindow(target, 6);
        else if (action == "maximize") ShowWindow(target, 3);
        else if (action == "restore") ShowWindow(target, 9);
        else if (action == "move")
        {
            SetWindowPos(target, IntPtr.Zero, x, y, w > 0 ? w : 0, h > 0 ? h : 0, 0x0004 | 0x0010);
            Thread.Sleep(R(120, 220));
        }
        else if (action == "info") { Thread.Sleep(R(5, 15)); }
        else if (action == "close") { PostMessage(target, 0x0010, IntPtr.Zero, IntPtr.Zero); Thread.Sleep(R(80, 160)); }
        else throw new InvalidOperationException("unknown window action: " + action);
        r["window"] = WinInfo(target, true);
        return r;
    }

    static void ForceForeground(IntPtr target)
    {
        IntPtr fg = GetForegroundWindow();
        uint fgPid = 0;
        uint tFg = GetWindowThreadProcessId(fg, out fgPid);
        uint tCur = GetCurrentThreadId();
        if (tFg != tCur) AttachThreadInput(tCur, tFg, true);
        try
        {
            BringWindowToTop(target);
            SetForegroundWindow(target);
        }
        finally
        {
            if (tFg != tCur) AttachThreadInput(tCur, tFg, false);
        }
    }

    static IntPtr FindWindow(string title, long hwnd)
    {
        if (hwnd > 0) return new IntPtr(hwnd);
        string needle = (title ?? "").Trim().ToLowerInvariant();
        IntPtr found = IntPtr.Zero;
        EnumWindows(delegate(IntPtr wh, IntPtr lp)
        {
            if (!IsWindowVisible(wh)) return true;
            StringBuilder t = new StringBuilder(512);
            GetWindowTextW(wh, t, t.Capacity);
            string s = t.ToString().ToLowerInvariant();
            if (s.Length == 0) return true;
            if (s == needle) { found = wh; return false; }
            if (found == IntPtr.Zero && s.Contains(needle)) found = wh;
            return true;
        }, IntPtr.Zero);
        return found;
    }

    // ---------------- mouse ----------------
    static void AbsMove(int x, int y)
    {
        int vw = VW, vh = VH;
        int nx = (int)Math.Round((x - VX) * 65535.0 / Math.Max(1, vw - 1));
        int ny = (int)Math.Round((y - VY) * 65535.0 / Math.Max(1, vh - 1));
        INPUT[] inp = new INPUT[1];
        inp[0].type = INPUT_MOUSE;
        inp[0].u.mi.dx = nx; inp[0].u.mi.dy = ny;
        inp[0].u.mi.flags = MOVE | ABSOLUTE | VIRTUALDESK;
        SendInput(1, inp, Marshal.SizeOf(typeof(INPUT)));
    }

    static void MoveHuman(int x0, int y0, int x1, int y1, int durationMs)
    {
        double dist = Math.Sqrt((double)(x1 - x0) * (x1 - x0) + (double)(y1 - y0) * (y1 - y0));
        if (dist < 2) { AbsMove(x1, y1); Thread.Sleep(R(20, 60)); return; }
        if (durationMs <= 0) durationMs = (int)Math.Min(750, Math.Max(170, dist * 0.45));
        int steps = (int)Math.Min(80, Math.Max(12, dist / 12.0));
        double ang = Math.Atan2(y1 - y0, x1 - x0);
        double bend = dist * (0.06 + D() * 0.10) * (D() < 0.5 ? -1 : 1);
        double ox = -Math.Sin(ang) * bend, oy = Math.Cos(ang) * bend;
        double c1x = x0 + (x1 - x0) * 0.30 + ox, c1y = y0 + (y1 - y0) * 0.30 + oy;
        double c2x = x0 + (x1 - x0) * 0.70 + ox * 0.55, c2y = y0 + (y1 - y0) * 0.70 + oy * 0.55;
        for (int i = 1; i <= steps; i++)
        {
            double t = (double)i / steps;
            double e = t < 0.5 ? 2 * t * t : 1 - Math.Pow(-2 * t + 2, 2) / 2;
            double mt = 1 - e;
            double bx = mt * mt * mt * x0 + 3 * mt * mt * e * c1x + 3 * mt * e * e * c2x + e * e * e * x1;
            double by = mt * mt * mt * y0 + 3 * mt * mt * e * c1y + 3 * mt * e * e * c2y + e * e * e * y1;
            if (t < 0.85) { bx += (D() - 0.5) * 1.6; by += (D() - 0.5) * 1.6; }
            AbsMove((int)Math.Round(bx), (int)Math.Round(by));
            Thread.Sleep(Math.Max(1, durationMs / steps + R(-2, 3)));
            DshHalt.Guard();
        }
        AbsMove(x1, y1);
    }

    static void MouseButton(string button, bool down)
    {
        uint flag;
        if (button == "right") flag = down ? RIGHTDOWN : RIGHTUP;
        else if (button == "middle") flag = down ? MIDDLEDOWN : MIDDLEUP;
        else flag = down ? LEFTDOWN : LEFTUP;
        INPUT[] inp = new INPUT[1];
        inp[0].type = INPUT_MOUSE;
        inp[0].u.mi.flags = flag;
        SendInput(1, inp, Marshal.SizeOf(typeof(INPUT)));
    }

    public static Hashtable Mouse(string action, int x, int y, int toX, int toY, string button, int count, int durationMs, int amount, string dir)
    {
        DshHalt.Guard();
        POINT cur; GetCursorPos(out cur);
        Hashtable r = new Hashtable();
        if (action == "move")
        {
            MoveHuman(cur.X, cur.Y, x, y, durationMs);
        }
        else if (action == "click" || action == "double" || action == "right" || action == "middle")
        {
            if (x >= 0 && y >= 0) MoveHuman(cur.X, cur.Y, x, y, durationMs);
            Thread.Sleep(R(55, 150));
            string btn = action == "right" ? "right" : action == "middle" ? "middle" : (button ?? "left");
            int times = action == "double" ? 2 : Math.Max(1, Math.Min(4, count));
            for (int i = 0; i < times; i++)
            {
                DshHalt.Guard();
                MouseButton(btn, true);
                Thread.Sleep(R(38, 95));
                MouseButton(btn, false);
                if (i < times - 1) Thread.Sleep(R(70, 130));
            }
        }
        else if (action == "down") MouseButton(button ?? "left", true);
        else if (action == "up") MouseButton(button ?? "left", false);
        else if (action == "drag")
        {
            int sx = x >= 0 ? x : cur.X, sy = y >= 0 ? y : cur.Y;
            MoveHuman(cur.X, cur.Y, sx, sy, durationMs > 0 ? durationMs : 0);
            Thread.Sleep(R(70, 160));
            MouseButton(button ?? "left", true);
            Thread.Sleep(R(90, 180));
            MoveHuman(sx, sy, toX, toY, 0);
            Thread.Sleep(R(110, 220));
            MouseButton(button ?? "left", false);
        }
        else if (action == "scroll")
        {
            if (x >= 0 && y >= 0) { MoveHuman(cur.X, cur.Y, x, y, 0); Thread.Sleep(R(45, 110)); }
            int n = Math.Max(1, count);
            int delta = 120 * Math.Max(1, Math.Abs(amount)) * (dir == "down" ? -1 : 1);
            for (int i = 0; i < n; i++)
            {
                DshHalt.Guard();
                INPUT[] inp = new INPUT[1];
                inp[0].type = INPUT_MOUSE;
                inp[0].u.mi.flags = WHEEL;
                inp[0].u.mi.mouseData = unchecked((uint)delta);
                SendInput(1, inp, Marshal.SizeOf(typeof(INPUT)));
                Thread.Sleep(R(28, 90));
            }
        }
        else throw new InvalidOperationException("unknown mouse action: " + action);
        Thread.Sleep(R(20, 60));
        POINT end; GetCursorPos(out end);
        r["ok"] = true;
        r["action"] = action;
        r["cursor"] = new Hashtable { { "x", end.X }, { "y", end.Y } };
        return r;
    }

    // ---------------- keyboard ----------------
    static readonly Dictionary<string, ushort> VkMap = new Dictionary<string, ushort>
    {
        { "enter", 0x0D }, { "return", 0x0D }, { "tab", 0x09 }, { "esc", 0x1B }, { "escape", 0x1B },
        { "space", 0x20 }, { "backspace", 0x08 }, { "delete", 0x2E }, { "del", 0x2E }, { "insert", 0x2D },
        { "home", 0x24 }, { "end", 0x23 }, { "pageup", 0x21 }, { "pagedown", 0x22 },
        { "up", 0x26 }, { "down", 0x28 }, { "left", 0x25 }, { "right", 0x27 },
        { "ctrl", 0x11 }, { "control", 0x11 }, { "shift", 0x10 }, { "alt", 0x12 }, { "win", 0x5B },
        { "capslock", 0x14 }, { "plus", 0xBB }, { "minus", 0xBD }, { "comma", 0xBC }, { "period", 0xBE },
        { "slash", 0xBF }, { "semicolon", 0xBA }, { "quote", 0xDE }, { "backslash", 0xDC },
        { "bracketleft", 0xDB }, { "bracketright", 0xDD }, { "backtick", 0xC0 },
    };

    static ushort VkFor(string name)
    {
        string k = name.Trim().ToLowerInvariant();
        if (VkMap.ContainsKey(k)) return VkMap[k];
        if (k.Length == 1)
        {
            short vk = VkKeyScanW(k[0]);
            if (vk != -1) return (ushort)(vk & 0xFF);
            return (ushort)char.ToUpperInvariant(k[0]);
        }
        int fn = 0;
        if (k.Length >= 2 && k[0] == 'f' && int.TryParse(k.Substring(1), out fn) && fn >= 1 && fn <= 24)
            return (ushort)(0x6F + fn);
        throw new InvalidOperationException("unknown key: " + name);
    }

    static void KeyDown(ushort vk) { SendVk(vk, false); }
    static void KeyUpKey(ushort vk) { SendVk(vk, true); }

    static void SendVk(ushort vk, bool up)
    {
        INPUT[] inp = new INPUT[1];
        inp[0].type = INPUT_KEY;
        inp[0].u.ki.vk = vk;
        inp[0].u.ki.scan = (ushort)MapVirtualKey(vk, 0);
        inp[0].u.ki.flags = up ? KEYUP : 0;
        uint n = SendInput(1, inp, Marshal.SizeOf(typeof(INPUT)));
        if (n == 0) throw new InvalidOperationException("SendInput refused the keystroke (is the target window elevated?)");
    }

    static void SendChar(char c)
    {
        INPUT[] inp = new INPUT[2];
        inp[0].type = INPUT_KEY;
        inp[0].u.ki.vk = 0;
        inp[0].u.ki.scan = c;
        inp[0].u.ki.flags = UNICODE;
        inp[1] = inp[0];
        inp[1].u.ki.flags = UNICODE | KEYUP;
        uint n = SendInput(2, inp, Marshal.SizeOf(typeof(INPUT)));
        if (n == 0) throw new InvalidOperationException("SendInput refused the character (is the target window elevated?)");
    }

    // Long-form text entry: put the text on the clipboard, press Ctrl+V, then
    // put the user's clipboard back. Typing 3000 characters one by one at a
    // human cadence would take three minutes; this takes 200 ms.
    public static Hashtable Paste(string text, bool restore)
    {
        DshHalt.Guard();
        Hashtable r = new Hashtable();
        r["ok"] = true;
        r["action"] = "paste";
        IDataObject prev = null;
        try { if (restore) prev = Clipboard.GetDataObject(); } catch { }
        SetClipboardText(text ?? "");
        Thread.Sleep(R(60, 130));
        KeyDown(0x11); Thread.Sleep(R(20, 45));
        KeyDown(0x56); Thread.Sleep(R(45, 90));
        KeyUpKey(0x56); Thread.Sleep(R(15, 40));
        KeyUpKey(0x11);
        Thread.Sleep(R(140, 260));
        if (restore && prev != null)
        {
            try { Clipboard.SetDataObject(prev, true); Thread.Sleep(R(30, 70)); } catch { }
        }
        r["chars"] = (text ?? "").Length;
        return r;
    }

    static void SetClipboardText(string s)
    {
        for (int i = 0; i < 10; i++)
        {
            try { Clipboard.SetText(s); return; }
            catch { Thread.Sleep(70); }
        }
        throw new InvalidOperationException("clipboard is busy - another application is holding it");
    }

    public static Hashtable Key(string action, string text, string[] keys, int delayMs, int repeat, int cps)
    {
        Hashtable r = new Hashtable();
        r["ok"] = true;
        r["action"] = action;
        if (action == "type")
        {
            string s = text ?? "";
            int baseDelay = delayMs > 0 ? delayMs : (cps > 0 ? (int)(1000.0 / cps) : 55);
            foreach (char c in s)
            {
                DshHalt.Guard();
                if (c == '\n') { KeyDown(0x0D); Thread.Sleep(R(20, 50)); KeyUpKey(0x0D); }
                else if (c == '\t') { KeyDown(0x09); Thread.Sleep(R(20, 50)); KeyUpKey(0x09); }
                else SendChar(c);
                int d = baseDelay + R(-(baseDelay / 3), baseDelay / 2 + 1);
                if (D() < 0.06) d += R(90, 260);
                Thread.Sleep(Math.Max(4, d));
            }
            r["chars"] = s.Length;
        }
        else if (action == "press" || action == "hold")
        {
            string[] combo = keys != null && keys.Length > 0 ? keys : new string[] { text ?? "" };
            int times = Math.Max(1, repeat);
            for (int i = 0; i < times; i++)
            {
                List<ushort> downs = new List<ushort>();
                foreach (string k in combo)
                {
                    ushort vk = VkFor(k);
                    KeyDown(vk); downs.Add(vk);
                    Thread.Sleep(R(18, 55));
                }
                int hold = action == "hold" ? R(320, 520) : R(35, 90);
                Thread.Sleep(hold);
                for (int j = downs.Count - 1; j >= 0; j--)
                {
                    KeyUpKey(downs[j]);
                    Thread.Sleep(R(12, 40));
                }
                if (i < times - 1) Thread.Sleep(R(90, 180));
            }
            r["keys"] = combo;
        }
        else throw new InvalidOperationException("unknown key action: " + action);
        Thread.Sleep(R(20, 60));
        return r;
    }
}

// ------------------------- pixel probe (cheap "seeing") -------------------------
// Reads pixels and returns numbers instead of an image, so the model can reason
// about a screen at ~50 tokens instead of ~15000. Modes: points / grid / find.
public static class DshProbe
{
    [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr h);
    [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr h, IntPtr dc);
    [DllImport("gdi32.dll")] static extern bool BitBlt(IntPtr dd, int dx, int dy, int w, int h, IntPtr sd, int sx, int sy, uint rop);

    static Bitmap Grab(int left, int top, int width, int height)
    {
        Bitmap bmp = new Bitmap(width, height, PixelFormat.Format32bppArgb);
        using (Graphics g = Graphics.FromImage(bmp))
        {
            IntPtr dd = g.GetHdc();
            IntPtr sd = GetDC(IntPtr.Zero);
            try
            {
                if (!BitBlt(dd, 0, 0, width, height, sd, left, top, 0x00CC0020u | 0x40000000u))
                    throw new InvalidOperationException("BitBlt failed, err=" + Marshal.GetLastWin32Error());
            }
            finally
            {
                ReleaseDC(IntPtr.Zero, sd);
                g.ReleaseHdc(dd);
            }
        }
        return bmp;
    }

    static int[] Pixels(Bitmap bmp)
    {
        int w = bmp.Width, h = bmp.Height;
        BitmapData d = bmp.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
        int[] px = new int[w * h];
        try
        {
            int[] line = new int[w];
            for (int y = 0; y < h; y++)
            {
                Marshal.Copy((IntPtr)((long)d.Scan0 + (long)y * d.Stride), line, 0, w);
                Array.Copy(line, 0, px, y * w, w);
            }
        }
        finally { bmp.UnlockBits(d); }
        return px;
    }

    public static Hashtable SavePng(int left, int top, int width, int height, string path, double scale)
    {
        DshHalt.Guard();
        if (width <= 0 || height <= 0) throw new InvalidOperationException("save needs width/height");
        using (Bitmap bmp = Grab(left, top, width, height))
        {
            Bitmap scaled = null;
            int outW = width, outH = height;
            try
            {
                Bitmap src = bmp;
                if (scale > 1.01)
                {
                    outW = (int)Math.Round(width * scale);
                    outH = (int)Math.Round(height * scale);
                    scaled = new Bitmap(outW, outH, PixelFormat.Format32bppArgb);
                    using (Graphics g = Graphics.FromImage(scaled))
                    {
                        g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
                        g.DrawImage(bmp, 0, 0, outW, outH);
                    }
                    src = scaled;
                }
                src.Save(path, ImageFormat.Png);
            }
            finally { if (scaled != null) scaled.Dispose(); }
            Hashtable r = new Hashtable();
            r["ok"] = true; r["path"] = path; r["width"] = outW; r["height"] = outH;
            return r;
        }
    }

    public static Hashtable Probe(int left, int top, int width, int height, string mode, string points,
        int cols, int rows, string hex, int tol, int minArea, int step, int maxResults)
    {
        DshHalt.Guard();
        if (width <= 0 || height <= 0) throw new InvalidOperationException("probe needs width/height");
        if ((long)width * (long)height > 4000000L) throw new InvalidOperationException("probe region too large (max 4M px)");
        if (mode == null || mode.Length == 0) mode = "points";
        using (Bitmap bmp = Grab(left, top, width, height))
        {
            Hashtable res = new Hashtable();
            res["left"] = left; res["top"] = top; res["width"] = width; res["height"] = height; res["mode"] = mode;

            if (mode == "points")
            {
                ArrayList pts = new ArrayList();
                if (points != null && points.Length > 0)
                {
                    string[] parts = points.Split(';');
                    foreach (string part in parts)
                    {
                        if (part.Trim().Length == 0) continue;
                        string[] xy = part.Split(',');
                        if (xy.Length < 2) continue;
                        int pxp = int.Parse(xy[0].Trim());
                        int pyp = int.Parse(xy[1].Trim());
                        int lx = pxp - left, ly = pyp - top;
                        string hxs = "-";
                        if (lx >= 0 && ly >= 0 && lx < width && ly < height)
                        {
                            Color c = bmp.GetPixel(lx, ly);
                            hxs = string.Format("#{0:x2}{1:x2}{2:x2}", c.R, c.G, c.B);
                        }
                        Hashtable item = new Hashtable();
                        item["x"] = pxp; item["y"] = pyp; item["hex"] = hxs;
                        pts.Add(item);
                    }
                }
                res["points"] = pts;
                return res;
            }

            int[] px = Pixels(bmp);

            if (mode == "grid")
            {
                if (cols < 1) cols = 16;
                if (rows < 1) rows = 9;
                if (cols > 80) cols = 80;
                if (rows > 60) rows = 60;
                ArrayList rowsOut = new ArrayList();
                for (int gy = 0; gy < rows; gy++)
                {
                    ArrayList row = new ArrayList();
                    int y0 = gy * height / rows, y1 = (gy + 1) * height / rows;
                    for (int gx = 0; gx < cols; gx++)
                    {
                        int x0 = gx * width / cols, x1 = (gx + 1) * width / cols;
                        long rs = 0, gs = 0, bs = 0; int n = 0;
                        for (int y = y0; y < y1; y += 2)
                        {
                            int off = y * width;
                            for (int x = x0; x < x1; x += 2)
                            {
                                int v = px[off + x];
                                rs += v & 0xFF; gs += (v >> 8) & 0xFF; bs += (v >> 16) & 0xFF; n++;
                            }
                        }
                        if (n == 0) n = 1;
                        row.Add(string.Format("#{0:x2}{1:x2}{2:x2}", (int)(rs / n), (int)(gs / n), (int)(bs / n)));
                    }
                    rowsOut.Add(row);
                }
                res["grid"] = rowsOut; res["cols"] = cols; res["rows"] = rows;
                return res;
            }

            string hx = (hex == null ? "" : hex.Trim().TrimStart('#'));
            if (hx.Length != 6) throw new InvalidOperationException("find needs color=#rrggbb");
            int tr = Convert.ToInt32(hx.Substring(0, 2), 16);
            int tg = Convert.ToInt32(hx.Substring(2, 2), 16);
            int tb = Convert.ToInt32(hx.Substring(4, 2), 16);
            if (tol < 0) tol = 30;
            if (step < 1) step = 2;
            if (maxResults < 1) maxResults = 30;
            long tol2 = (long)tol * tol * 3L;

            byte[] mask = new byte[width * height];
            for (int y = 0; y < height; y += step)
            {
                int off = y * width;
                for (int x = 0; x < width; x += step)
                {
                    int v = px[off + x];
                    int dr = (v & 0xFF) - tr, dg = ((v >> 8) & 0xFF) - tg, db = ((v >> 16) & 0xFF) - tb;
                    if ((long)dr * dr + (long)dg * dg + (long)db * db <= tol2) mask[off + x] = 1;
                }
            }

            System.Collections.Generic.List<Hashtable> boxes = new System.Collections.Generic.List<Hashtable>();
            System.Collections.Generic.Stack<int> st = new System.Collections.Generic.Stack<int>();
            for (int i = 0; i < mask.Length; i++)
            {
                if (mask[i] != 1) continue;
                int minX = int.MaxValue, minY = int.MaxValue, maxX = -1, maxY = -1, cnt = 0;
                st.Push(i); mask[i] = 2;
                while (st.Count > 0)
                {
                    int idx = st.Pop();
                    int yy = idx / width, xx = idx - yy * width;
                    if (xx < minX) minX = xx;
                    if (xx > maxX) maxX = xx;
                    if (yy < minY) minY = yy;
                    if (yy > maxY) maxY = yy;
                    cnt++;
                    if (xx >= step && mask[idx - step] == 1) { mask[idx - step] = 2; st.Push(idx - step); }
                    if (xx + step < width && mask[idx + step] == 1) { mask[idx + step] = 2; st.Push(idx + step); }
                    if (yy >= step && mask[idx - step * width] == 1) { mask[idx - step * width] = 2; st.Push(idx - step * width); }
                    if (yy + step < height && mask[idx + step * width] == 1) { mask[idx + step * width] = 2; st.Push(idx + step * width); }
                }
                int area = cnt * step * step;
                if (area < minArea) continue;
                Hashtable b = new Hashtable();
                b["x"] = minX + left; b["y"] = minY + top;
                b["w"] = maxX - minX + step; b["h"] = maxY - minY + step;
                b["cx"] = minX + left + (maxX - minX) / 2;
                b["cy"] = minY + top + (maxY - minY) / 2;
                b["area"] = area;
                boxes.Add(b);
            }
            boxes.Sort(delegate(Hashtable a, Hashtable b) { return ((int)b["area"]).CompareTo((int)a["area"]); });
            ArrayList outl = new ArrayList();
            for (int i = 0; i < boxes.Count && i < maxResults; i++) outl.Add(boxes[i]);
            res["matches"] = outl;
            res["total"] = boxes.Count;
            return res;
        }
    }
}

// ------------------------- emergency stop -------------------------
// A dedicated thread owns Ctrl+Shift+C (halt) and Ctrl+Shift+X (resume) via
// thread hotkeys, so the stop works even while the main thread is busy typing
// or moving the mouse. Level 1 = halted, 2 = halted + user asked to end the run
// (Ctrl+Shift+C followed by V).
public static class DshHalt
{
    public static volatile int Level;
    public static volatile string Hotkey = "";
    public static volatile bool StopRegistered;
    public static volatile bool ResumeRegistered;
    static volatile string statePath;

    const int WM_HOTKEY = 0x0312;
    const uint MOD_ALT = 0x0001, MOD_CTRL = 0x0002, MOD_SHIFT = 0x0004, MOD_NOREPEAT = 0x4000;
    const int VK_C = 0x43, VK_X = 0x58, VK_V = 0x56;
    const int ID_STOP = 1, ID_RESUME = 2;

    [StructLayout(LayoutKind.Sequential)]
    struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public int x; public int y; }

    [DllImport("user32.dll")] static extern bool RegisterHotKey(IntPtr h, int id, uint mods, uint vk);
    [DllImport("user32.dll")] static extern bool UnregisterHotKey(IntPtr h, int id);
    [DllImport("user32.dll")] static extern int GetMessage(out MSG m, IntPtr h, uint min, uint max);
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int vk);

    public static string StateFile { get { return statePath; } }

    public static void Start(string path)
    {
        statePath = path;
        Write();
        Thread t = new Thread(Pump);
        t.IsBackground = true;
        t.Name = "dsh-halt-hotkeys";
        t.Start();
    }

    static void Pump()
    {
        StopRegistered = RegisterHotKey(IntPtr.Zero, ID_STOP, MOD_CTRL | MOD_SHIFT | MOD_NOREPEAT, VK_C);
        ResumeRegistered = RegisterHotKey(IntPtr.Zero, ID_RESUME, MOD_CTRL | MOD_SHIFT | MOD_NOREPEAT, VK_X);
        Write();
        // The hotkey is global: when a second session (or any other program)
        // already owns it, registration fails. Fall back to watching the key
        // state directly so the brake still works instead of silently doing
        // nothing.
        if (!StopRegistered || !ResumeRegistered) StartPolling();
        MSG m;
        while (GetMessage(out m, IntPtr.Zero, 0, 0) > 0)
        {
            if (m.message != WM_HOTKEY) continue;
            int id = m.wParam.ToInt32();
            if (id == ID_STOP) OnStop();
            else if (id == ID_RESUME) OnResume();
        }
    }

    static void StartPolling()
    {
        Thread t = new Thread(delegate()
        {
            bool wasStop = false, wasResume = false;
            while (true)
            {
                Thread.Sleep(30);
                bool mod = Down(0x11) && Down(0x10); // ctrl + shift
                if (!StopRegistered)
                {
                    bool now = mod && Down(VK_C);
                    if (now && !wasStop) OnStop();
                    wasStop = now;
                }
                if (!ResumeRegistered)
                {
                    bool now = mod && Down(VK_X);
                    if (now && !wasResume) OnResume();
                    wasResume = now;
                }
            }
        });
        t.IsBackground = true;
        t.Name = "dsh-halt-poll";
        t.Start();
    }

    static void OnStop()
    {
        Level = 1;
        Hotkey = "ctrl+shift+c";
        Write();
        ArmEscalation();
    }

    static void OnResume()
    {
        Level = 0;
        Hotkey = "ctrl+shift+x";
        Write();
    }

    // Ctrl+Shift+C then V within ~2.6s escalates to "end this run".
    static void ArmEscalation()
    {
        Thread t = new Thread(delegate()
        {
            // A key already held down must not escalate: wait for release first.
            for (int i = 0; i < 60 && Down(VK_V); i++) Thread.Sleep(25);
            int until = Environment.TickCount + 2600;
            while (Environment.TickCount < until)
            {
                if (Level == 0) return;
                if (Down(VK_V)) { Level = 2; Hotkey = "ctrl+shift+c+v"; Write(); return; }
                Thread.Sleep(20);
            }
            if (Level == 2) return; // still terminated, nothing to do
        });
        t.IsBackground = true;
        t.Name = "dsh-halt-escalate";
        t.Start();
    }

    static bool Down(int vk) { return (GetAsyncKeyState(vk) & 0x8000) != 0; }

    static void Write()
    {
        string p = statePath;
        if (p == null) return;
        try
        {
            string json = "{\"level\":" + Level + ",\"hotkey\":\"" + Hotkey + "\",\"at\":"
                + DateTime.UtcNow.Ticks + ",\"stop\":" + (StopRegistered ? "true" : "false")
                + ",\"resume\":" + (ResumeRegistered ? "true" : "false") + "}";
            File.WriteAllText(p, json);
        }
        catch { }
    }

    // Thrown by every input / capture entry point while halted.
    public static void Guard()
    {
        if (Level == 0) return;
        throw new InvalidOperationException(Level >= 2
            ? "HALTED: user pressed ctrl+shift+c+v and asked to end this run"
            : "HALTED: user pressed ctrl+shift+c");
    }
}
'@

Add-Type -TypeDefinition $src -ReferencedAssemblies 'System.Drawing', 'System.Windows.Forms'

$in = [Console]::OpenStandardInput()
$out = [Console]::OpenStandardOutput()
$reader = New-Object System.IO.StreamReader($in, (New-Object System.Text.UTF8Encoding($false)))
$writer = New-Object System.IO.StreamWriter($out, (New-Object System.Text.UTF8Encoding($false)))
$writer.AutoFlush = $true

function ConvertTo-JsonValue($v) {
    if ($null -eq $v) { return 'null' }
    if ($v -is [bool]) { if ($v) { return 'true' } else { return 'false' } }
    if ($v -is [string]) { return (ConvertTo-JsonString $v) }
    if ($v -is [System.Collections.IDictionary]) {
        $parts = @()
        foreach ($k in $v.Keys) {
            $parts += ((ConvertTo-JsonString ([string]$k)) + ':' + (ConvertTo-JsonValue $v[$k]))
        }
        return '{' + ($parts -join ',') + '}'
    }
    if ($v -is [System.Collections.IEnumerable]) {
        $items = @()
        foreach ($it in $v) { $items += (ConvertTo-JsonValue $it) }
        return '[' + ($items -join ',') + ']'
    }
    return ([string]::Format([Globalization.CultureInfo]::InvariantCulture, '{0}', $v))
}

function ConvertTo-JsonCompact($o) { return (ConvertTo-JsonValue $o) }


function ConvertTo-JsonString($s) {
    $sb = New-Object System.Text.StringBuilder
    [void]$sb.Append('"')
    foreach ($ch in $s.ToCharArray()) {
        switch ($ch) {
            '"' { [void]$sb.Append('\"') }
            '\' { [void]$sb.Append('\\') }
            "`n" { [void]$sb.Append('\n') }
            "`r" { [void]$sb.Append('\r') }
            "`t" { [void]$sb.Append('\t') }
            default {
                if ([int]$ch -lt 32) { [void]$sb.Append(('\u{0:x4}' -f [int]$ch)) }
                else { [void]$sb.Append($ch) }
            }
        }
    }
    [void]$sb.Append('"')
    return $sb.ToString()
}

$haltDir = Join-Path ([System.IO.Path]::GetTempPath()) 'dsh-gui-control'
try { [void][System.IO.Directory]::CreateDirectory($haltDir) } catch { }
$haltFile = Join-Path $haltDir ('halt-' + $PID + '.json')
[DshHalt]::Start($haltFile)
Start-Sleep -Milliseconds 180

# ---------------- OCR (Windows.Media.Ocr) ----------------
# Turns a screen region into text + rects, so the model can read a UI for
# ~100 tokens instead of paying for a picture.
$script:OcrAsTask = $null
function Get-AsTaskMethod {
    if ($null -eq $script:OcrAsTask) {
        $script:OcrAsTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
            $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
        })[0]
    }
    return $script:OcrAsTask
}
function Await-WinRt($op, $type) {
    $m = Get-AsTaskMethod
    $task = $m.MakeGenericMethod($type).Invoke($null, @($op))
    $null = $task.Wait(-1)
    return $task.Result
}
function Invoke-OcrRegion([int]$left, [int]$top, [int]$w, [int]$h, [double]$scale, [string]$lang) {
    if ($w -le 0 -or $h -le 0) { throw 'ocr needs width/height' }
    if ($scale -le 0) { $scale = 1.0 }
    $tmp = Join-Path $env:TEMP ('dsh-ocr-' + [guid]::NewGuid().ToString('N') + '.png')
    $info = [DshProbe]::SavePng($left, $top, $w, $h, $tmp, $scale)
    try {
        [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime] | Out-Null
        [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime] | Out-Null
        [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
        $file = Await-WinRt ([Windows.Storage.StorageFile]::GetFileFromPathAsync($tmp)) ([Windows.Storage.StorageFile])
        $stream = Await-WinRt ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
        $decoder = Await-WinRt ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
        $sb = Await-WinRt ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
        $engine = $null
        if ($lang -and $lang.Length -gt 0) {
            try {
                $lg = New-Object Windows.Globalization.Language($lang)
                $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lg)
            } catch { $engine = $null }
        }
        if ($null -eq $engine) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }
        if ($null -eq $engine) { throw 'OCR engine unavailable (install a language pack)' }
        $result = Await-WinRt ($engine.RecognizeAsync($sb)) ([Windows.Media.Ocr.OcrResult])
        $lines = New-Object System.Collections.ArrayList
        foreach ($row in $result.Lines) {
            $minX = [double]::MaxValue; $minY = [double]::MaxValue; $maxX = 0.0; $maxY = 0.0
            $has = $false
            foreach ($wd in $row.Words) {
                $wr = $wd.BoundingRect
                if (-not $has) {
                    $minX = $wr.X; $minY = $wr.Y; $maxX = $wr.X + $wr.Width; $maxY = $wr.Y + $wr.Height; $has = $true
                } else {
                    if ($wr.X -lt $minX) { $minX = $wr.X }
                    if ($wr.Y -lt $minY) { $minY = $wr.Y }
                    if (($wr.X + $wr.Width) -gt $maxX) { $maxX = $wr.X + $wr.Width }
                    if (($wr.Y + $wr.Height) -gt $maxY) { $maxY = $wr.Y + $wr.Height }
                }
            }
            if (-not $has) { continue }
            $txt = [string]$row.Text
            $txt = [regex]::Replace($txt, '(?<=[\u4e00-\u9fff])\s+(?=[\u4e00-\u9fff])', '')
            $item = @{}
            $item['t'] = $txt
            $item['x'] = [int][math]::Round(($minX / $scale) + $left)
            $item['y'] = [int][math]::Round(($minY / $scale) + $top)
            $item['w'] = [int][math]::Round((($maxX - $minX) / $scale))
            $item['h'] = [int][math]::Round((($maxY - $minY) / $scale))
            [void]$lines.Add($item)
        }
        @{ ok = $true; left = $left; top = $top; width = [int]$info.width; height = [int]$info.height; scale = $scale; engine = [string]$engine.RecognizerLanguage.LanguageTag; count = $lines.Count; lines = $lines }
    } finally {
        Remove-Item $tmp -Force -ErrorAction SilentlyContinue
    }
}

$writer.WriteLine('{"ok":true,"ready":true,"pid":' + $PID + ',"haltFile":' + (ConvertTo-JsonString $haltFile) + ',"hotkeys":{"stop":' + $(if ([DshHalt]::StopRegistered) { 'true' } else { 'false' }) + ',"resume":' + $(if ([DshHalt]::ResumeRegistered) { 'true' } else { 'false' }) + '}}')

while ($true) {
    $line = $reader.ReadLine()
    if ($null -eq $line) { break }
    if ($line.Trim().Length -eq 0) { continue }
    try {
        $req = $line | ConvertFrom-Json
        $cmd = [string]$req.cmd
        $res = $null
        switch ($cmd) {
            'ping' { $res = @{ ok = $true; pong = $true; pid = $PID } }
            'info' {
                $res = [DshWin]::Info([bool]$req.includeWindows, [int]($(if ($req.limit) { $req.limit } else { 40 })))
            }
            'capture' {
                $res = [DshWin]::Capture(
                    [int]($(if ($null -ne $req.left) { $req.left } else { 0 })),
                    [int]($(if ($null -ne $req.top) { $req.top } else { 0 })),
                    [int]($(if ($null -ne $req.width) { $req.width } else { 0 })),
                    [int]($(if ($null -ne $req.height) { $req.height } else { 0 })),
                    [string]($(if ($req.format) { $req.format } else { 'jpeg' })),
                    [int]($(if ($req.quality) { $req.quality } else { 68 })),
                    [int]($(if ($null -ne $req.maxWidth) { $req.maxWidth } else { 0 })),
                    [int]($(if ($null -ne $req.maxHeight) { $req.maxHeight } else { 0 })),
                    [bool]$req.grayscale, [bool]$req.cursor, [bool]$req.grid,
                    [string]$req.path,
                    [int]($(if ($null -ne $req.maxBytes) { $req.maxBytes } else { 0 })))
            }
            'mouse' {
                $res = [DshWin]::Mouse([string]$req.action,
                    [int]($(if ($null -ne $req.x) { $req.x } else { -1 })),
                    [int]($(if ($null -ne $req.y) { $req.y } else { -1 })),
                    [int]($(if ($null -ne $req.toX) { $req.toX } else { 0 })),
                    [int]($(if ($null -ne $req.toY) { $req.toY } else { 0 })),
                    [string]($(if ($req.button) { $req.button } else { 'left' })),
                    [int]($(if ($req.count) { $req.count } else { 1 })),
                    [int]($(if ($null -ne $req.durationMs) { $req.durationMs } else { 0 })),
                    [int]($(if ($req.amount) { $req.amount } else { 1 })),
                    [string]($(if ($req.direction) { $req.direction } else { 'up' })))
            }
            'key' {
                $keys = @()
                if ($req.keys) { foreach ($k in $req.keys) { $keys += [string]$k } }
                $res = [DshWin]::Key([string]$req.action, [string]$req.text, $keys,
                    [int]($(if ($req.delayMs) { $req.delayMs } else { 0 })),
                    [int]($(if ($req.repeat) { $req.repeat } else { 1 })),
                    [int]($(if ($req.cps) { $req.cps } else { 0 })))
            }
            'paste' {
                $res = [DshWin]::Paste([string]$req.text, [bool]($req.restore -ne $false))
            }
            'window' {
                $res = [DshWin]::Window([string]$req.action, [string]$req.title, [long]($(if ($req.hwnd) { $req.hwnd } else { 0 })),
                    [int]($(if ($null -ne $req.x) { $req.x } else { 0 })),
                    [int]($(if ($null -ne $req.y) { $req.y } else { 0 })),
                    [int]($(if ($null -ne $req.w) { $req.w } else { 0 })),
                    [int]($(if ($null -ne $req.h) { $req.h } else { 0 })))
            }
            'halt' {
                $res = @{
                    ok = $true
                    level = [int][DshHalt]::Level
                    hotkey = [string][DshHalt]::Hotkey
                    stopHotkey = [bool][DshHalt]::StopRegistered
                    resumeHotkey = [bool][DshHalt]::ResumeRegistered
                    haltFile = [string]$haltFile
                }
            }
            'quit' { $writer.WriteLine('{"ok":true,"bye":true}'); break }
            'probe' {
                $res = [DshProbe]::Probe(
                    [int]($(if ($null -ne $req.left) { $req.left } else { 0 })),
                    [int]($(if ($null -ne $req.top) { $req.top } else { 0 })),
                    [int]($(if ($null -ne $req.width) { $req.width } else { 0 })),
                    [int]($(if ($null -ne $req.height) { $req.height } else { 0 })),
                    [string]$req.mode, [string]$req.points,
                    [int]($(if ($req.cols) { $req.cols } else { 0 })),
                    [int]($(if ($req.rows) { $req.rows } else { 0 })),
                    [string]$req.color,
                    [int]($(if ($null -ne $req.tolerance) { $req.tolerance } else { 30 })),
                    [int]($(if ($null -ne $req.minArea) { $req.minArea } else { 40 })),
                    [int]($(if ($null -ne $req.step) { $req.step } else { 2 })),
                    [int]($(if ($null -ne $req.maxResults) { $req.maxResults } else { 30 })))
            }
            'ocr' {
                $res = Invoke-OcrRegion `
                    ([int]($(if ($null -ne $req.left) { $req.left } else { 0 }))) `
                    ([int]($(if ($null -ne $req.top) { $req.top } else { 0 }))) `
                    ([int]($(if ($null -ne $req.width) { $req.width } else { 0 }))) `
                    ([int]($(if ($null -ne $req.height) { $req.height } else { 0 }))) `
                    ([double]($(if ($null -ne $req.scale) { $req.scale } else { 1.0 }))) `
                    ([string]$req.lang)
            }
            default { throw ('unknown cmd: ' + $cmd) }
        }
        if ($res -is [System.Collections.IDictionary]) {
            $res['id'] = [string]$req.id
            $res['halt'] = [int][DshHalt]::Level
        }
        $writer.WriteLine((ConvertTo-JsonCompact $res))
    }
    catch {
        $msg = $_.Exception.Message
        if ($_.Exception.InnerException) { $msg = $msg + ' | ' + $_.Exception.InnerException.Message }
        $writer.WriteLine((ConvertTo-JsonCompact @{ id = [string]$req.id; ok = $false; error = $msg; cmd = [string]$cmd; halt = [int][DshHalt]::Level }))
    }
    if ($cmd -eq 'quit') { break }
}

# Do not leave a stale state file behind for a future process to inherit.
try { [System.IO.File]::Delete($haltFile) } catch { }
