using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Management;
using System.Runtime.InteropServices;
using System.Text;

namespace GrayCode.ComputerHost {
  internal sealed class WindowIdentity {
    public string id,title,className,executable,commandLine,processStartedAt,monitorId,ownerId;
    public int processId,dpi;
    public bool minimized,foreground;
    public object bounds,captureBounds;
    internal Win32.Rect NativeBounds,FrameBounds;
  }
  internal static class DesktopWindows {
    internal static IntPtr Parse(string id) {
      long value;if(!long.TryParse(id,NumberStyles.Integer,CultureInfo.InvariantCulture,out value)||value==0)throw new ComputerException("WINDOW_NOT_FOUND","窗口 ID 无效，请重新读取窗口列表。");
      var window=new IntPtr(value);if(!Win32.IsWindow(window))throw new ComputerException("WINDOW_NOT_FOUND","窗口已经关闭，请重新选择。");return window;
    }
    internal static void RequireInteractive() {
      var desktop=Win32.OpenInputDesktop(0,false,0x0001);if(desktop==IntPtr.Zero)throw new ComputerException("DESKTOP_UNAVAILABLE","当前输入桌面不可用，可能已锁屏或处于系统权限提示。");
      try {
        var name=new StringBuilder(256);int needed;
        if(!Win32.GetUserObjectInformation(desktop,2,name,name.Capacity*2,out needed)||!string.Equals(name.ToString(),"Default",StringComparison.OrdinalIgnoreCase))
          throw new ComputerException("DESKTOP_UNAVAILABLE","当前不是可交互的普通桌面，请由用户恢复桌面后重新观察。");
      } finally {Win32.CloseDesktop(desktop);}
    }
    internal static bool SameRoot(IntPtr actual,IntPtr target) { return actual==target||Win32.GetAncestor(actual,2)==target; }
    internal static WindowIdentity Describe(IntPtr window,bool detailed) {
      if(!Win32.IsWindow(window))throw new ComputerException("WINDOW_NOT_FOUND","窗口已经关闭。");
      Win32.Rect bounds;if(!Win32.GetWindowRect(window,out bounds))throw new ComputerException("WINDOW_NOT_FOUND","无法读取窗口边界。");
      var title=new StringBuilder(2048);var cls=new StringBuilder(256);Win32.GetWindowText(window,title,title.Capacity);Win32.GetClassName(window,cls,cls.Capacity);
      uint processId;Win32.GetWindowThreadProcessId(window,out processId);
      var result=new WindowIdentity {id=window.ToInt64().ToString(CultureInfo.InvariantCulture),title=title.ToString(),className=cls.ToString(),processId=(int)processId,
        minimized=Win32.IsIconic(window),foreground=SameRoot(Win32.GetForegroundWindow(),window),NativeBounds=bounds,bounds=Json.Rect(bounds),dpi=96,
        ownerId=Win32.GetWindow(window,4).ToInt64().ToString(CultureInfo.InvariantCulture)};
      Win32.Rect frame;result.FrameBounds=Win32.DwmGetWindowAttribute(window,9,out frame,Marshal.SizeOf(typeof(Win32.Rect)))==0?frame:bounds;result.captureBounds=Json.Rect(result.FrameBounds);
      try {result.dpi=(int)Win32.GetDpiForWindow(window);}catch(EntryPointNotFoundException){}
      var monitor=Win32.MonitorFromWindow(window,2);var monitorInfo=new Win32.MonitorInfo {Size=Marshal.SizeOf(typeof(Win32.MonitorInfo))};
      if(Win32.GetMonitorInfo(monitor,ref monitorInfo))result.monitorId=monitorInfo.Device;
      try {using(var process=Process.GetProcessById((int)processId)) {result.processStartedAt=process.StartTime.ToUniversalTime().ToString("o");try{result.executable=process.MainModule.FileName;}catch(System.ComponentModel.Win32Exception){}}}
      catch(ArgumentException) {throw new ComputerException("WINDOW_NOT_FOUND","窗口所属进程已经退出。");}
      catch(System.ComponentModel.Win32Exception) {result.processStartedAt=null;}
      if(detailed) {
        try {using(var search=new ManagementObjectSearcher("SELECT CommandLine FROM Win32_Process WHERE ProcessId="+processId.ToString(CultureInfo.InvariantCulture)))using(var records=search.Get())foreach(ManagementObject record in records)result.commandLine=Convert.ToString(record["CommandLine"],CultureInfo.InvariantCulture);}
        catch(ManagementException) {} catch(UnauthorizedAccessException) {}
      }
      return result;
    }
    internal static object List() {
      RequireInteractive();var windows=new List<WindowIdentity>();
      Win32.EnumWindows(delegate(IntPtr window,IntPtr ignored) {
        if(!Win32.IsWindowVisible(window))return true;
        int cloaked;if(Win32.DwmGetWindowAttribute(window,14,out cloaked,sizeof(int))==0&&cloaked!=0)return true;
        try {var item=Describe(window,false);if(item.title.Length>0&&item.NativeBounds.Right>item.NativeBounds.Left&&item.NativeBounds.Bottom>item.NativeBounds.Top)windows.Add(item);}catch(ComputerException){}
        return true;
      },IntPtr.Zero);
      var displays=new List<object>();
      Win32.EnumDisplayMonitors(IntPtr.Zero,IntPtr.Zero,delegate(IntPtr monitor,IntPtr dc,ref Win32.Rect rect,IntPtr ignored) {
        var info=new Win32.MonitorInfo {Size=Marshal.SizeOf(typeof(Win32.MonitorInfo))};if(!Win32.GetMonitorInfo(monitor,ref info))return true;
        uint factor=100;try{Win32.GetScaleFactorForMonitor(monitor,out factor);}catch(EntryPointNotFoundException){}
        displays.Add(new{id=info.Device,bounds=Json.Rect(info.Monitor),workArea=Json.Rect(info.Work),scaleFactor=factor/100.0,primary=(info.Flags&1)!=0});return true;
      },IntPtr.Zero);
      return new {capturedAt=Json.Now,windows=windows,displays=displays,coordinateSystem="physical-screen-pixels"};
    }
    internal static void Verify(WindowIdentity observed,bool foreground,bool allowMinimized=false) {
      var current=Describe(Parse(observed.id),false);
      if(observed.processStartedAt==null)throw new ComputerException("PROCESS_IDENTITY_UNAVAILABLE","无法核实目标进程身份，请由用户检查目标权限。");
      if(current.processId!=observed.processId||current.processStartedAt!=observed.processStartedAt||current.className!=observed.className||current.title!=observed.title||current.dpi!=observed.dpi||current.monitorId!=observed.monitorId||!Json.Same(current.NativeBounds,observed.NativeBounds)||!Json.Same(current.FrameBounds,observed.FrameBounds))
        throw new ComputerException("OBSERVATION_STALE","窗口身份、位置或尺寸已经变化，请重新观察。");
      if(current.minimized&&!allowMinimized)throw new ComputerException("WINDOW_MINIMIZED","窗口已最小化，请先恢复并重新观察。");
      if(foreground&&!current.foreground)throw new ComputerException("FOCUS_CHANGED","目标窗口没有前台焦点，请先聚焦并重新观察。");
    }
  }
}
