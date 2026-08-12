// GrayCode toast-linger (.NET Framework 4.x build - tiny footprint, no runtime dependency)
// Sends a WinRT toast and lingers with a message loop. Clicking the toast raises the
// in-process Activated event (the only activation path that works on Win11 24H2+/25H2).
// On click: focus the VSCode window + write marker file for the extension (openChat).
// Also self-registers the AUMID shortcut (required to raise toasts at all).
using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Security;
using System.Text;
using System.Windows.Forms;
using Windows.Data.Xml.Dom;
using Windows.UI.Notifications;

class Program
{
    [DllImport("user32.dll")] static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hWnd);

    [ComImport, Guid("000214F9-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IShellLinkW
    {
        void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszFile, int cch, IntPtr pfd, uint fFlags);
        void GetIDList(out IntPtr ppidl);
        void SetIDList(IntPtr pidl);
        void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszName, int cch);
        void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string pszName);
        void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszDir, int cch);
        void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string pszDir);
        void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszArgs, int cch);
        void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string pszArgs);
        void GetHotkey(out ushort pwHotkey);
        void SetHotkey(ushort wHotkey);
        void GetShowCmd(out int piShowCmd);
        void SetShowCmd(int iShowCmd);
        void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszIconPath, int cch, out int piIcon);
        void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string pszIconPath, int iIcon);
        void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string pszPathRel, uint dwReserved);
        void Resolve(IntPtr hwnd, uint fFlags);
        void SetPath([MarshalAs(UnmanagedType.LPWStr)] string pszFile);
    }

    [ComImport, Guid("0000010B-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPersistFile
    {
        void GetClassID(out Guid pClassID);
        [PreserveSig] int IsDirty();
        void Load([MarshalAs(UnmanagedType.LPWStr)] string pszFileName, uint dwMode);
        [PreserveSig] int Save([MarshalAs(UnmanagedType.LPWStr)] string pszFileName, [MarshalAs(UnmanagedType.Bool)] bool fRemember);
        void SaveCompleted([MarshalAs(UnmanagedType.LPWStr)] string pszFileName);
        void GetCurFile([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder ppszFileName);
    }

    [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPropertyStore
    {
        [PreserveSig] int GetCount(out uint cProps);
        [PreserveSig] int GetAt(uint iProp, out PROPERTYKEY pkey);
        [PreserveSig] int GetValue(ref PROPERTYKEY key, out PROPVARIANT pv);
        [PreserveSig] int SetValue(ref PROPERTYKEY key, ref PROPVARIANT pv);
        [PreserveSig] int Commit();
    }

    [StructLayout(LayoutKind.Sequential)]
    struct PROPERTYKEY
    {
        public Guid fmtid;
        public uint pid;
    }

    [StructLayout(LayoutKind.Explicit)]
    struct PROPVARIANT
    {
        [FieldOffset(0)] public ushort vt;
        [FieldOffset(8)] public IntPtr pwszVal;
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    static extern int SHGetPropertyStoreFromParsingName([MarshalAs(UnmanagedType.LPWStr)] string pszPath, IntPtr pbc, uint flags, ref Guid riid, out IPropertyStore ppv);

    [DllImport("ole32.dll")]
    static extern int CoCreateInstance(ref Guid rclsid, IntPtr pUnkOuter, uint dwClsContext, ref Guid riid, out IShellLinkW ppv);

    [DllImport("ole32.dll")]
    static extern int PropVariantClear(ref PROPVARIANT pvar);

    static readonly Guid CLSID_ShellLink = new Guid("00021401-0000-0000-C000-000000000046");
    static readonly Guid IID_IShellLinkW = new Guid("000214F9-0000-0000-C000-000000000046");
    static readonly Guid IID_IPropertyStore = new Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99");

    static bool EnsureShortcut(string aumid, string exePath, string log)
    {
        try
        {
            string lnkPath = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                @"Microsoft\Windows\Start Menu\Programs\GrayCode.lnk");

            if (File.Exists(lnkPath)) { try { File.Delete(lnkPath); } catch { } }

            Guid clsid = CLSID_ShellLink;
            Guid iidLink = IID_IShellLinkW;
            Guid iidStore = IID_IPropertyStore;
            IShellLinkW link;
            int hr = CoCreateInstance(ref clsid, IntPtr.Zero, 1, ref iidLink, out link);
            if (hr != 0) { Log(log, "shortcut CoCreateInstance failed hr=" + hr); return false; }
            link.SetPath(exePath);
            IPersistFile pf = (IPersistFile)link;
            hr = pf.Save(lnkPath, true);
            Marshal.FinalReleaseComObject(link);
            if (hr != 0) { Log(log, "shortcut save failed hr=" + hr); return false; }

            IPropertyStore store;
            hr = SHGetPropertyStoreFromParsingName(lnkPath, IntPtr.Zero, 2, ref iidStore, out store);
            if (hr != 0) { Log(log, "shortcut propertystore failed hr=" + hr); return false; }
            PROPERTYKEY key = new PROPERTYKEY();
            key.fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"); // PKEY_AppUserModel_ID
            key.pid = 5;
            PROPVARIANT pv = new PROPVARIANT();
            pv.vt = 31; // VT_LPWSTR
            pv.pwszVal = Marshal.StringToCoTaskMemUni(aumid);
            hr = store.SetValue(ref key, ref pv);
            if (hr == 0) hr = store.Commit();
            PropVariantClear(ref pv);
            Marshal.FinalReleaseComObject(store);
            Log(log, "shortcut ensured " + lnkPath + " hr=" + hr);
            return hr == 0;
        }
        catch (Exception e)
        {
            Log(log, "shortcut error: " + e.Message);
            return false;
        }
    }

    [STAThread]
    static int Main(string[] args)
    {
        string aumid = args.Length > 0 ? args[0] : "GrayCode.Notification";
        string title = args.Length > 1 ? args[1] : "GrayCode";
        string message = args.Length > 2 ? args[2] : "";
        int lingerMs = 30000;
        string lingerArgError = null;
        if (args.Length > 3 && !int.TryParse(args[3], out lingerMs)) lingerArgError = args[3];
        bool silent = true;
        string silentArgError = null;
        if (args.Length > 4 && !bool.TryParse(args[4], out silent)) silentArgError = args[4];
        string marker = Path.Combine(Path.GetTempPath(), "graycode-toast-clicked.flag");
        string log = Path.Combine(Path.GetTempPath(), "graycode-toast-linger.log");
        MarkerPath = marker;
        LogPath = log;
        Log(log, "start aumid=" + aumid + " title=" + title);
        // E-23：参数解析失败不再静默回退——记日志，便于排查行为与预期不符的问题
        if (lingerArgError != null) Log(log, "warning: invalid lingerMs arg ignored: " + lingerArgError);
        if (silentArgError != null) Log(log, "warning: invalid silent arg ignored: " + silentArgError);

        string exePath = "";
        try
        {
            using (Process self = Process.GetCurrentProcess())
            {
                exePath = self.MainModule.FileName;
            }
        }
        catch { }
        if (!string.IsNullOrEmpty(exePath)) EnsureShortcut(aumid, exePath, log);

        // E-04：title/message 来自通知内容（可能含模型生成文本），拼接进 XML 前必须先转义：
        // 含 & / < / > 等字符直接拼串会让 doc.LoadXml 抛 XmlException 导致通知静默失效，
        // 同时封堵了向 toast XML 注入任意节点的面。
        string xml = "<toast><visual><binding template=\"ToastGeneric\">"
            + "<text>" + SecurityElement.Escape(title) + "</text><text>" + SecurityElement.Escape(message) + "</text>"
            + "</binding></visual>"
            + (silent
                ? "<audio silent=\"true\"/>"
                : "<audio src=\"ms-winsoundevent:Notification.Default\"/>") +
            "</toast>";
        try
        {
            XmlDocument doc = new XmlDocument();
            doc.LoadXml(xml);
            ToastNotification toast = new ToastNotification(doc);

            toast.Activated += OnActivated;
            toast.Dismissed += OnDismissed;
            toast.Failed += OnFailed;

            ToastNotifier notifier = ToastNotificationManager.CreateToastNotifier(aumid);
            notifier.Show(toast);
            Log(log, "shown");
        }
        catch (Exception e)
        {
            // 失败写日志并以非零码退出，供扩展侧（show_windows_notification）读取 stderr 定位问题
            Log(log, "toast build/show failed: " + e.Message);
            return 2;
        }

        Form form = new Form
        {
            ShowInTaskbar = false,
            Opacity = 0,
            WindowState = FormWindowState.Minimized,
            Visible = false
        };
        Timer timer = new Timer { Interval = lingerMs };
        timer.Tick += (s, e) => { timer.Stop(); form.Close(); };
        timer.Start();
        Application.Run(form);
        Log(log, "exit");
        return 0;
    }

    static void OnActivated(ToastNotification sender, object args)
    {
        Log(LogPath, "ACTIVATED");
        try { File.WriteAllText(MarkerPath, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss.fff")); } catch { }
        try
        {
            foreach (Process p in Process.GetProcesses())
            {
                try
                {
                    if (p.ProcessName.StartsWith("Code", StringComparison.OrdinalIgnoreCase)
                        && p.MainWindowHandle != IntPtr.Zero)
                    {
                        IntPtr h = p.MainWindowHandle;
                        if (IsIconic(h)) ShowWindowAsync(h, 9); // SW_RESTORE
                        bool ok = SetForegroundWindow(h);
                        if (!ok)
                        {
                            ShowWindowAsync(h, 6); // SW_MINIMIZE
                            ShowWindowAsync(h, 9); // SW_RESTORE
                            SetForegroundWindow(h);
                        }
                        BringWindowToTop(h);
                        Log(LogPath, "focused hwnd=" + h);
                        break;
                    }
                }
                catch { }
            }
        }
        catch { }
    }

    static void OnDismissed(ToastNotification sender, ToastDismissedEventArgs args)
    {
        Log(LogPath, "DISMISSED reason=" + args.Reason);
    }

    static void OnFailed(ToastNotification sender, ToastFailedEventArgs args)
    {
        Log(LogPath, "FAILED code=" + args.ErrorCode);
    }

    static string MarkerPath = "";
    static string LogPath = "";

    // E-23：日志超过阈值直接截断重建（按天轮转对本工具的调用频率意义不大，
    // 阈值截断最简单且足够：防止 %TEMP% 下日志无限增长）
    const long LOG_MAX_BYTES = 1024 * 1024; // 1 MB

    static void Log(string path, string msg)
    {
        try
        {
            if (File.Exists(path) && new FileInfo(path).Length > LOG_MAX_BYTES)
            {
                File.Delete(path);
            }
            File.AppendAllText(path, DateTime.Now.ToString("HH:mm:ss.fff") + " " + msg + Environment.NewLine);
        }
        catch { }
    }
}
